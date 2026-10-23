"""Real Chromium checks for the Canva → private Drive photos → Sheet → Doc UI.

Run: python3 tests/browser_smoke.py [--app index.html] [--artifacts /tmp/feed-studio-tests]
Requires Chromium, Playwright for Python and Pillow. The built HTML, CSS and
browser image decoder are real; same-origin workflow APIs are mocked. No .env,
provider account, API key, OAuth exchange or external request is needed.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import quote, urlsplit

from PIL import Image
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "index.html"
ARTIFACTS = Path(tempfile.mkdtemp(prefix="feed-studio-tests-"))
CANVA_URL = "https://www.canva.com/design/DAExample/edit"
SHEET = {"id": "sheet123", "url": "https://docs.google.com/spreadsheets/d/sheet123/edit"}
FOLDER = {"id": "folder123", "url": "https://drive.google.com/drive/folders/folder123"}
DOCUMENT = {"id": "doc123", "url": "https://docs.google.com/document/d/doc123/edit"}
CSRF = "browser-test-csrf"


class WorkflowAPI:
    """Small stateful server fixture; rejects every unexpected API endpoint."""

    def __init__(self, test, *, configured=None, connected=None, public_origin=None):
        self.test = test
        self.calls = []
        self.unexpected = []
        self.fetches = []
        self.configured = configured or {"canva": True, "google": True}
        self.connected = connected or {"canva": True, "google": True}
        self.public_origin = public_origin or test.origin
        self.running = False
        self.import_error = None
        self.export_failures = 0
        self.refresh_error = None
        self.posts = self.blank_posts()
        self.refreshed_posts = [dict(post, caption=f"Reviewed caption for {post['id']}.",
                                     hashtags=f"#Hotel #{post['id']}") for post in self.posts]
        self.job = None
        self.test.page.route("**/api/**", self.handle)
        self.test.page.add_init_script("""(() => {
          const original = window.fetch;
          window.__workflowFetches = [];
          window.fetch = function(input, options) {
            window.__workflowFetches.push({url: String(input), method: options?.method || 'GET',
              credentials: options?.credentials || 'same-origin'});
            return original.apply(this, arguments);
          };
        })();""")

    @staticmethod
    def blank_posts(order="GRID"):
        return [{"id": f"p{index}", "name": f"page-{index:02d}." + ("png" if index == 2 else "jpg"),
                 "mime": "image/png" if index == 2 else "image/jpeg", "width": 720, "height": 900,
                 "sourceIndex": index, "publication": 4 - index if order == "GRID" else index,
                 "caption": "", "hashtags": ""} for index in range(1, 4)]

    def reply(self, route, body, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body))

    def handle(self, route):
        request = route.request
        path = urlsplit(request.url).path
        call = {"path": path, "method": request.method, "headers": request.all_headers()}
        if request.method == "POST":
            call["body"] = request.post_data_json
        self.calls.append(call)
        if path == "/api/session" and request.method == "GET":
            self.reply(route, {"serverMode": True, "publicOrigin": self.public_origin,
                               "csrfToken": CSRF, "configured": self.configured,
                               "connected": self.connected})
        elif path in ("/api/import", "/api/resume") and request.method == "POST":
            operation = "resume" if path.endswith("resume") else "import"
            order = call["body"].get("orderMode", "GRID")
            self.posts = self.blank_posts(order)
            self.job = {"id": "resume123" if operation == "resume" else "job123",
                        "operation": operation, "status": "ready", "stage": "ready",
                        "title": call["body"].get("title", "Canva feed"), "orderMode": order,
                        "sheet": SHEET, "folder": FOLDER, "posts": deepcopy(self.posts)}
            if operation == "resume":
                self.job["posts"] = deepcopy(self.refreshed_posts)
                self.job["reused"] = True
            self.reply(route, {"jobId": self.job["id"]}, 202)
        elif self.job and path == "/api/jobs/" + self.job["id"] and request.method == "GET":
            job = deepcopy(self.job)
            if self.running:
                job.update(status="running", stage="creating-sheet", posts=[])
                job.pop("sheet", None)
                job.pop("folder", None)
            elif self.import_error:
                job = {"id": self.job["id"], "operation": self.job["operation"], "status": "error",
                       "stage": "error", "error": self.import_error, "posts": []}
            self.reply(route, job)
        elif self.job and re.fullmatch(r"/api/jobs/[^/]+/images/p[123]", path) and request.method == "GET":
            index = int(path[-1]) - 1
            route.fulfill(status=200, content_type=self.posts[index]["mime"],
                          body=self.test.images[index].read_bytes())
        elif self.job and path == "/api/jobs/" + self.job["id"] + "/refresh" and request.method == "POST":
            if self.refresh_error:
                self.reply(route, {"error": self.refresh_error}, 422)
                return
            self.job.update(posts=deepcopy(self.refreshed_posts), status="ready", stage="ready")
            self.reply(route, self.job)
        elif self.job and path == "/api/jobs/" + self.job["id"] + "/export" and request.method == "POST":
            self.job.update(operation="export", status="ready", stage="ready")
            if self.export_failures:
                self.export_failures -= 1
                self.job["error"] = "Google Docs creation failed. Retry the final document."
                self.job.pop("document", None)
            else:
                self.job.pop("error", None)
                self.job["document"] = DOCUMENT
            self.reply(route, {"jobId": self.job["id"]}, 202)
        else:
            self.unexpected.append(call)
            self.reply(route, {"error": "Unexpected test API endpoint: " + path}, 404)

    def mutations(self, suffix=None):
        return [call for call in self.calls if call["method"] == "POST"
                and (suffix is None or call["path"].endswith(suffix))]


class BrowserSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        cls.images = []
        for index, color in enumerate(["#a33632", "#27834b", "#346fb0"], start=1):
            path = ARTIFACTS / (f"{index:02d}.png" if index == 2 else f"{index:02d}.jpg")
            Image.new("RGB", (720, 900), color).save(path)
            cls.images.append(path)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=shutil.which("chromium") or shutil.which("google-chrome"),
            headless=True, args=["--no-sandbox"],
        )

        class QuietHandler(SimpleHTTPRequestHandler):
            def log_message(self, _format, *args):
                pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(APP.parent)))
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        cls.url = cls.origin + "/" + quote(APP.name)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=1)

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1050})
        self.context.add_cookies([{"name": "workflow_test_session", "value": "browser-session", "url": self.origin}])
        self.page = self.context.new_page()
        self.page_errors = []
        self.external_requests = []
        self.requests = []
        self.api = None
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.page.on("request", lambda request: self.requests.append(request.url))

        def guard(route):
            if urlsplit(route.request.url).scheme in ("http", "https") and not route.request.url.startswith(self.origin + "/"):
                self.external_requests.append(route.request.url)
                route.abort("blockedbyclient")
            else:
                route.continue_()
        self.page.route("**/*", guard)

    def tearDown(self):
        if self._outcome.result.failures or self._outcome.result.errors:
            try:
                self.page.screenshot(path=str(ARTIFACTS / (self.id().split(".")[-1] + ".png")), full_page=True)
            except Exception:
                pass
        self.context.close()
        self.assertEqual(self.page_errors, [], "Unexpected browser JavaScript error")
        self.assertEqual(self.external_requests, [], "The workflow must use only same-origin server APIs")
        if self.api:
            self.assertEqual(self.api.unexpected, [], "Unexpected API call")

    @property
    def cards(self):
        return self.page.locator("#cards article[data-post-id]")

    def load(self, **session):
        self.api = WorkflowAPI(self, **session)
        html = APP.read_text()
        marker = 'name="feed-studio-mode" content="offline"'
        self.assertEqual(html.count(marker), 1, "Built app must declare its standalone offline mode")
        html = html.replace(marker, 'name="feed-studio-mode" content="server"')
        self.page.route(self.url, lambda route: route.fulfill(status=200, content_type="text/html", body=html))
        self.page.goto(self.url, wait_until="load")
        expect(self.page.locator("#mode-new")).to_be_visible()
        expect(self.page.locator("#job-status")).to_be_attached()
        expect.poll if False else None  # Keep polling in Playwright's normal locator assertions.
        return self.api

    def start(self, order="GRID", *, wait=True):
        expect(self.page.locator("#create-planning")).to_be_enabled()
        self.page.locator("#project-title").fill("Canva feed")
        self.page.locator("#order-mode").select_option(order)
        self.page.locator("#canva-url").fill(CANVA_URL)
        self.page.locator("#create-planning").click()
        if wait:
            expect(self.cards).to_have_count(3, timeout=10000)
            expect(self.page.locator("#open-sheet")).to_be_visible()

    def card(self, post_id):
        return self.page.locator(f'#cards article[data-post-id="{post_id}"]')

    def assert_images_decoded(self):
        expect(self.cards.locator("img")).to_have_count(3)
        self.page.wait_for_function("""() => [...document.querySelectorAll('#cards img')].every(
          image => image.complete && image.naturalWidth === 720 && image.naturalHeight === 900)""")
        for image in self.cards.locator("img").all():
            self.assertTrue(image.get_attribute("src").startswith("/api/jobs/") or
                            image.get_attribute("src").startswith(self.origin + "/api/jobs/"))

    def assert_mutation_security(self):
        for call in self.api.mutations():
            self.assertEqual(call["headers"].get("x-csrf-token"), CSRF)
            self.assertIn("workflow_test_session=browser-session", call["headers"].get("cookie", ""))
            self.assertNotIn("authorization", call["headers"])
        fetches = self.page.evaluate("window.__workflowFetches")
        for call in fetches:
            if call["method"].upper() == "POST":
                self.assertEqual(call["credentials"], "same-origin")
        self.assertNotIn(CSRF, self.page.locator("body").inner_text())

    def test_01_offline_artifact_explains_server_requirement_without_ai_or_upload(self):
        self.page.goto(self.url, wait_until="load")
        expect(self.page.locator("#create-planning")).to_be_disabled()
        expect(self.page.locator("#connect-canva")).to_be_disabled()
        expect(self.page.locator("#connect-google")).to_be_disabled()
        expect(self.page.locator("body")).to_contain_text(re.compile("serveur", re.I))
        self.assertEqual(self.page.locator('input[type="file"], #api-key, #ai-model, #generate-captions').count(), 0)
        self.assertEqual(self.cards.count(), 0)
        self.assertFalse(any("/api/" in url for url in self.requests), self.requests)
        self.assertFalse(any("openai" in url.lower() for url in self.requests))

    def test_02_import_creates_sheet_then_refresh_and_final_doc_use_same_origin(self):
        api = self.load()
        self.start()
        expect(self.page.locator("#open-sheet")).to_have_attribute("href", SHEET["url"])
        expect(self.page.locator("#open-document")).to_be_hidden()
        self.assert_images_decoded()
        self.assertEqual(api.mutations("/import")[0]["body"],
                         {"url": CANVA_URL, "title": "Canva feed", "orderMode": "GRID"})
        self.assertEqual(len(api.mutations()), 1, "Import must not create a Doc or write captions")
        self.page.locator("#refresh-texts").click()
        for post in api.refreshed_posts:
            expect(self.card(post["id"])).to_contain_text(post["caption"])
            expect(self.card(post["id"])).to_contain_text(post["hashtags"])
        self.page.locator("#export-document").click()
        expect(self.page.locator("#open-document")).to_be_visible(timeout=10000)
        expect(self.page.locator("#open-document")).to_have_attribute("href", DOCUMENT["url"])
        self.assertEqual(len(api.mutations("/refresh")), 1)
        self.assertEqual(len(api.mutations("/export")), 1)
        self.assert_mutation_security()
        self.page.screenshot(path=str(ARTIFACTS / "sheet-to-document.png"), full_page=True)

    def test_03_sheet_values_and_reordered_rows_stay_attached_to_owned_photo_ids(self):
        api = self.load()
        self.start()
        api.refreshed_posts = [api.refreshed_posts[index] for index in [2, 0, 1]]
        self.page.locator("#refresh-texts").click()
        expect(self.cards.first).to_have_attribute("data-post-id", "p3")
        for post in api.refreshed_posts:
            card = self.card(post["id"])
            expect(card).to_contain_text(post["caption"])
            expect(card).to_contain_text(post["name"])
            expect(card.locator("img")).to_have_attribute("src", re.compile("/images/" + post["id"] + "$"))
        self.assertEqual(self.cards.locator("textarea, input, [contenteditable=true]").count(), 0,
                         "Captions and hashtags are read from the Sheet")
        self.assertEqual(self.cards.locator("[draggable=true]").count(), 0)
        self.assert_mutation_security()

    def test_04_sheet_markup_is_literal_text_and_never_creates_dom_elements(self):
        api = self.load()
        self.start()
        attack = '<img id="sheet-injection" src="x" onerror="window.sheetInjected=true"> & <script>alert(1)</script>'
        api.refreshed_posts[0].update(caption=attack, hashtags='<svg id="tag-injection" onload="window.sheetInjected=true">')
        self.page.locator("#refresh-texts").click()
        expect(self.card("p1")).to_contain_text(attack)
        expect(self.card("p1")).to_contain_text('<svg id="tag-injection"')
        self.assertEqual(self.page.locator("#sheet-injection, #tag-injection, #cards script").count(), 0)
        self.assertFalse(self.page.evaluate("Boolean(window.sheetInjected)"))

    def test_05_resume_after_browser_restart_needs_google_only_and_sheet_link(self):
        api = self.load()
        self.start()
        api.connected = {"canva": False, "google": True}
        api.configured = {"canva": False, "google": True}
        self.page.evaluate("localStorage.clear(); sessionStorage.clear()")
        self.page.reload(wait_until="load")
        expect(self.cards).to_have_count(0)
        expect(self.page.locator("#create-planning")).to_be_disabled()
        self.page.locator("#mode-resume").click()
        expect(self.page.locator("#resume-planning-form")).to_be_visible()
        expect(self.page.locator("#resume-planning")).to_be_enabled()
        self.page.locator("#sheet-url").fill(SHEET["url"])
        self.page.locator("#resume-planning").click()
        expect(self.cards).to_have_count(3, timeout=10000)
        expect(self.page.locator("#open-sheet")).to_have_attribute("href", SHEET["url"])
        self.assertEqual(api.mutations("/resume")[0]["body"], {"sheetUrl": SHEET["url"]})
        self.assertEqual(len(api.mutations("/import")), 1)
        self.page.locator("#export-document").click()
        expect(self.page.locator("#open-document")).to_have_attribute("href", DOCUMENT["url"], timeout=10000)
        self.assertTrue(all("canva.com" not in call["path"] for call in api.calls))
        self.assert_mutation_security()

    def test_06_publication_order_is_sent_to_server_and_displayed_without_reordering(self):
        api = self.load()
        self.start("PUBLICATION")
        self.assertEqual(api.mutations("/import")[0]["body"]["orderMode"], "PUBLICATION")
        self.assertEqual(self.cards.evaluate_all("cards => cards.map(card => card.dataset.postId)"), ["p1", "p2", "p3"])
        for index, card in enumerate(self.cards.all(), start=1):
            expect(card).to_contain_text(re.compile(r"Publication\s*0?" + str(index), re.I))
        expect(self.page.locator("#order-mode")).to_be_disabled()

    def test_07_failed_export_preserves_sheet_photos_text_and_allows_retry(self):
        api = self.load()
        self.start()
        self.page.locator("#refresh-texts").click()
        expect(self.card("p1")).to_contain_text("Reviewed caption for p1.")
        api.export_failures = 1
        self.page.locator("#export-document").click()
        expect(self.page.locator("#app-error")).to_contain_text("Google Docs creation failed", timeout=10000)
        expect(self.page.locator("#open-sheet")).to_have_attribute("href", SHEET["url"])
        expect(self.page.locator("#open-document")).to_be_hidden()
        expect(self.cards).to_have_count(3)
        expect(self.card("p1")).to_contain_text("Reviewed caption for p1.")
        self.assert_images_decoded()
        expect(self.page.locator("#export-document")).to_be_enabled()
        self.page.locator("#export-document").click()
        expect(self.page.locator("#open-document")).to_have_attribute("href", DOCUMENT["url"], timeout=10000)
        expect(self.page.locator("#app-error")).to_be_hidden()
        self.assertEqual(len(api.mutations("/export")), 2)

    def test_08_failed_import_never_claims_sheet_or_document_and_can_retry(self):
        api = self.load()
        api.import_error = "Canva refused this design. Check your access."
        self.start(wait=False)
        expect(self.page.locator("#app-error")).to_contain_text("Canva refused", timeout=10000)
        expect(self.page.locator("#open-sheet")).to_be_hidden()
        expect(self.page.locator("#open-document")).to_be_hidden()
        expect(self.cards).to_have_count(0)
        expect(self.page.locator("#create-planning")).to_be_enabled()
        api.import_error = None
        self.start()
        self.assertEqual(len(api.mutations("/import")), 2)

    def test_09_stop_tracking_does_not_cancel_server_or_duplicate_import(self):
        api = self.load()
        api.running = True
        self.page.locator("#project-title").fill("Canva feed")
        self.page.locator("#canva-url").fill(CANVA_URL)
        expect(self.page.locator("#create-planning")).to_be_enabled()
        self.page.locator("#create-planning").evaluate("button => { button.click(); button.click(); }")
        expect(self.page.locator("#stop-waiting")).to_be_visible()
        expect(self.page.locator("#create-planning")).to_be_disabled()
        self.page.locator("#stop-waiting").click()
        expect(self.page.locator("#job-status")).to_contain_text(re.compile("serveur|continue", re.I))
        self.assertNotRegex(self.page.locator("#job-status").inner_text().lower(), r"(?:traitement|import|serveur)\s+annul[ée]")
        self.assertEqual(len(api.mutations()), 1)
        self.assertFalse(any("cancel" in call["path"] for call in api.calls))
        api.running = False
        self.page.locator("#continue-waiting").click()
        expect(self.cards).to_have_count(3, timeout=10000)
        self.assertEqual(len(api.mutations("/import")), 1)

    def test_10_unconfigured_providers_disable_workflow_and_explain_setup(self):
        api = self.load(configured={"canva": False, "google": False}, connected={"canva": False, "google": False})
        expect(self.page.locator("#connect-canva")).to_be_disabled()
        expect(self.page.locator("#connect-google")).to_be_disabled()
        expect(self.page.locator("#create-planning")).to_be_disabled()
        self.page.locator("#mode-resume").click()
        expect(self.page.locator("#resume-planning")).to_be_disabled()
        expect(self.page.locator("body")).to_contain_text(re.compile("administrateur|configur", re.I))
        self.assertEqual(api.mutations(), [])

    def test_11_mismatched_public_origin_disables_actions_with_guidance(self):
        api = self.load(public_origin="https://wrong-origin.example")
        expect(self.page.locator("#create-planning")).to_be_disabled()
        expect(self.page.locator("#connect-canva")).to_be_disabled()
        expect(self.page.locator("#connect-google")).to_be_disabled()
        self.page.locator("#mode-resume").click()
        expect(self.page.locator("#resume-planning")).to_be_disabled()
        expect(self.page.locator("body")).to_contain_text(re.compile("PUBLIC_ORIGIN|origine|adresse", re.I))
        self.assertEqual(api.mutations(), [])

    def test_12_refresh_failure_preserves_current_sheet_text_and_mobile_layout(self):
        api = self.load()
        self.start()
        self.page.locator("#refresh-texts").click()
        expect(self.card("p2")).to_contain_text("Reviewed caption for p2.")
        api.refresh_error = "Keep the planning Sheet headers intact."
        self.page.locator("#refresh-texts").click()
        expect(self.page.locator("#app-error")).to_contain_text("Sheet headers", timeout=10000)
        expect(self.card("p2")).to_contain_text("Reviewed caption for p2.")
        expect(self.page.locator("#open-sheet")).to_have_attribute("href", SHEET["url"])
        expect(self.page.locator("#refresh-texts")).to_be_enabled()
        for width in [390, 1440]:
            self.page.set_viewport_size({"width": width, "height": 900})
            self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width + 1)
            self.page.screenshot(path=str(ARTIFACTS / f"planning-{width}.png"), full_page=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=APP)
    parser.add_argument("--artifacts", type=Path, default=ARTIFACTS)
    args, remaining = parser.parse_known_args()
    APP = args.app.resolve()
    ARTIFACTS = args.artifacts.resolve()
    if not APP.is_file():
        parser.error(f"Standalone app not built: {APP}")
    if not (shutil.which("chromium") or shutil.which("google-chrome")):
        parser.error("Chromium or Google Chrome is required")
    print(f"Browser artifacts: {ARTIFACTS}", flush=True)
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
