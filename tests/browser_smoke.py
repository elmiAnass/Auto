"""Real Chromium checks for the standalone app; caption API requests are mocked.

Run: python3 tests/browser_smoke.py [--app index.html] [--artifacts /tmp/feed-studio-tests]
Requires Chromium, Playwright for Python, Pillow and python-docx. No production
Google/OpenAI account is used, and these tests do not assess AI writing quality.
By default a temporary local HTTP server serves the single-file app; --file-url
tests direct file opening when the browser's administrator policy permits it.
"""

from __future__ import annotations

import argparse
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
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from urllib.parse import quote, urlsplit

from PIL import Image
from docx import Document
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "index.html"
ARTIFACTS = Path(tempfile.mkdtemp(prefix="feed-studio-tests-"))
FILE_URL = False
NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def inspect_document(file_path: Path) -> dict:
    """Open with a real DOCX reader and independently inspect XML/media order."""
    document = Document(file_path)
    with ZipFile(file_path) as archive:
        assert archive.testzip() is None, "DOCX ZIP checksum failure"
        xml_bytes = archive.read("word/document.xml")
        xml = ET.fromstring(xml_bytes)
        relationships = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
        targets = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in relationships.findall("rel:Relationship", NS)
        }
        ordered_media = []
        for blip in xml.findall(".//a:blip", NS):
            target = targets[blip.attrib[f"{{{NS['r']}}}embed"]]
            name = target.lstrip("/") if target.startswith("/") else "word/" + target
            ordered_media.append(archive.read(name))
        explicit_breaks = len(xml.findall(".//w:br[@w:type='page']", NS))
        before_breaks = len(xml.findall(".//w:pageBreakBefore", NS))
        text = "\n".join(element.text or "" for element in xml.findall(".//w:t", NS))
    return {
        "document": document,
        "text": text,
        "media": ordered_media,
        "page_breaks": explicit_breaks + before_breaks,
        "xml": xml_bytes,
    }


class BrowserSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        cls.images = []
        for index, color in enumerate(["#a33632", "#27834b", "#346fb0"], start=1):
            image_path = ARTIFACTS / f"{index:02d}.jpg"
            Image.new("RGB", (720, 900), color).save(image_path, quality=93)
            cls.images.append(image_path)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=shutil.which("chromium") or shutil.which("google-chrome"),
            headless=True,
            args=["--no-sandbox"],
        )
        cls.server = None
        if FILE_URL:
            cls.url = APP.resolve().as_uri()
        else:
            class QuietHandler(SimpleHTTPRequestHandler):
                def log_message(self, _format, *args):
                    pass
            cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(APP.parent)))
            cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
            cls.server_thread.start()
            cls.url = f"http://127.0.0.1:{cls.server.server_port}/{quote(APP.name)}"

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        if cls.server:
            cls.server.shutdown()
            cls.server.server_close()
            cls.server_thread.join(timeout=1)

    def setUp(self):
        self.context = self.browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1050})
        self.page = self.context.new_page()
        self.page_errors = []
        self.requests = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.page.on("request", lambda request: self.requests.append(request.url))
        self.page.goto(self.url, wait_until="load")
        expect(self.page.locator("#export-doc")).to_be_attached()

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.page_errors, [], "Unexpected browser JavaScript error")

    @property
    def cards(self):
        return self.page.locator("#cards [data-post-id]")

    def upload(self, paths=None):
        selected = self.images if paths is None else paths
        self.file_picker().set_input_files([str(item) for item in selected])
        if selected:
            expect(self.cards).to_have_count(len(selected))
        return self.cards

    def file_picker(self):
        picker = self.page.locator("#photo-input")
        if picker.evaluate("element => element.tagName") != "INPUT":
            picker = picker.locator('input[type="file"]')
        return picker

    def preview_names(self):
        return self.page.locator("#grid-preview img").evaluate_all("images => images.map(image => image.alt)")

    def connect_key(self):
        field = self.page.locator("#api-key")
        field.evaluate("element => { const details = element.closest('details'); if (details) details.open = true; }")
        field.fill("sk-test-abcdefghijklmnop")

    def download_doc(self, name):
        with self.page.expect_download(timeout=15000) as event:
            self.page.locator("#export-doc").click()
        download = event.value
        self.assertTrue(download.suggested_filename.endswith(".docx"))
        destination = ARTIFACTS / name
        download.save_as(destination)
        return inspect_document(destination)

    def mock_captions(self, statuses=None):
        calls = []
        remaining_statuses = list(statuses or [])

        def handler(route):
            if route.request.method == "OPTIONS":
                route.fulfill(status=204, headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "authorization, content-type",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                })
                return
            payload = route.request.post_data_json
            calls.append(payload)
            status = remaining_statuses.pop(0) if remaining_statuses else 200
            if status == 200:
                draft = {
                    "subject": "Visible image subject " + str(len(calls)),
                    "caption": "English caption for selected photo " + str(len(calls)) + ".",
                    "hashtags": ["#TravelDesign", "#VisualStory"],
                }
                body = {"status": "completed", "output": [{"type": "message", "content": [{
                    "type": "output_text", "text": json.dumps(draft)
                }]}]}
            else:
                body = {"error": {"message": "Untrusted server error with sensitive-key-never-display"}}
            route.fulfill(status=status, content_type="application/json", headers={
                "Access-Control-Allow-Origin": "*"
            }, body=json.dumps(body))

        self.page.route("https://api.openai.com/v1/responses", handler)
        return calls

    def load_connected_mode(self, *, configured=True, job_error=None, openai=False, generation_statuses=None):
        """Mock same-origin server APIs while keeping real client DOM/image loading."""
        calls = []
        remaining_generation_statuses = list(generation_statuses or [])
        document = {"id": "doc123", "url": "https://docs.google.com/document/d/doc123/edit"}
        metadata = [{"id": f"p{index}", "name": f"page-{index:02d}.jpg", "mime": "image/jpeg", "sourceIndex": index}
                    for index in range(1, 4)]

        def api_handler(route):
            request = route.request
            endpoint = urlsplit(request.url).path
            entry = {"path": endpoint, "method": request.method, "headers": request.all_headers()}
            if request.method == "POST":
                entry["body"] = request.post_data_json
            calls.append(entry)
            if endpoint == "/api/session":
                body = {"csrfToken": "test-csrf", "configured": {"canva": configured, "google": configured, "openai": openai},
                        "connected": {"canva": configured, "google": configured}}
            elif endpoint == "/api/import" and request.method == "POST":
                body = {"jobId": "job123"}
            elif endpoint == "/api/jobs/job123":
                body = {"id": "job123", "status": "error", "error": job_error} if job_error else {
                    "id": "job123", "status": "ready", "title": "Canva feed", "orderMode": "GRID",
                    "document": document, "posts": metadata,
                }
            elif re.fullmatch(r"/api/jobs/job123/images/p[123]", endpoint):
                number = int(endpoint[-1])
                route.fulfill(status=200, content_type="image/jpeg", body=self.images[number - 1].read_bytes())
                return
            elif endpoint == "/api/jobs/job123/generate-caption" and request.method == "POST":
                status = remaining_generation_statuses.pop(0) if remaining_generation_statuses else 200
                if status != 200:
                    route.fulfill(status=status, content_type="application/json", body=json.dumps({
                        "error": "Caption generation temporarily unavailable. Try again."
                    }))
                    return
                image_id = entry["body"]["imageId"]
                required = entry["body"]["context"]["requiredHashtags"]
                body = {"subject": "Visible subject of " + image_id,
                        "caption": "Server English caption for " + image_id + ".",
                        "hashtags": " ".join(required + ["#TravelDesign", "#VisualStory"])}
            elif endpoint == "/api/jobs/job123/captions" and request.method == "POST":
                posts = entry["body"]["posts"]
                body = {"updated": 6, "document": document, "posts": [
                    {"id": post["id"], "syncedCaption": post["caption"], "syncedHashtags": post["hashtags"]}
                    for post in posts
                ]}
            else:
                route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "Unexpected test endpoint"}))
                return
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

        marker = 'name="feed-studio-mode" content="offline"'
        html = APP.read_text()
        self.assertEqual(html.count(marker), 1, "Expected the standalone app's explicit mode marker")
        html = html.replace(marker, 'name="feed-studio-mode" content="server"')
        self.page.route("**/api/**", api_handler)
        self.page.route(self.url, lambda route: route.fulfill(status=200, content_type="text/html", body=html))
        self.page.reload(wait_until="load")
        if configured:
            expect(self.page.locator("#canva-import")).to_be_enabled()
        else:
            expect(self.page.locator("#canva-status")).to_contain_text("administrateur")
        return calls

    def start_canva_import(self):
        self.page.locator("#project-title").fill("Canva feed")
        self.page.locator("#order-mode").select_option("GRID")
        self.page.locator("#canva-url").fill("https://www.canva.com/design/DAExample/edit")
        self.page.locator("#canva-import").click()

    def test_01_standalone_page_loads_without_network_dependencies(self):
        self.assertFalse(any(url != self.url and url.startswith(("https://", "http://")) for url in self.requests), self.requests)
        self.assertEqual(self.page.locator("#api-key").input_value(), "")

    def test_02_upload_manual_edit_and_grid_docx_preserve_originals(self):
        self.upload()
        self.page.locator("#order-mode").select_option("GRID")
        self.page.locator("#project-title").fill('Courtyard & Rooms <Review>')
        self.cards.nth(0).locator('textarea[data-field="caption"]').fill("A quiet courtyard, ready for your next pause.")
        self.cards.nth(0).locator('textarea[data-field="hashtags"]').fill("#Hotel #Courtyard")
        result = self.download_doc("grid-manual.docx")
        self.assertEqual(result["media"], [path.read_bytes() for path in reversed(self.images)])
        self.assertEqual(result["page_breaks"], 2)
        self.assertIn("A quiet courtyard, ready for your next pause.", result["text"])
        self.assertIn("#Hotel #Courtyard", result["text"])
        self.assertEqual(result["document"].core_properties.title, 'Courtyard & Rooms <Review>')
        self.assertNotIn("sk-test-", result["text"])
        self.assertFalse(any("api.openai.com" in url for url in self.requests))

    def test_03_publication_order_keeps_input_order_without_ai(self):
        self.upload()
        self.page.locator("#order-mode").select_option("PUBLICATION")
        result = self.download_doc("publication-no-key.docx")
        self.assertEqual(result["media"], [path.read_bytes() for path in self.images])
        self.assertEqual(result["page_breaks"], 2)
        self.assertIn("caption", result["text"].lower())
        self.assertIn("hashtag", result["text"].lower())

    def test_04_caption_requests_include_image_and_each_account_type(self):
        for account in ["hotel", "restaurant"]:
            with self.subTest(account=account):
                self.page.reload(wait_until="load")
                calls = self.mock_captions()
                self.upload([self.images[0]])
                self.page.locator("#account-type").select_option(account)
                self.connect_key()
                self.page.locator("#generate-captions").click()
                expect(self.cards.nth(0).locator('textarea[data-field="caption"]')).to_have_value(re.compile("English caption"), timeout=10000)
                self.assertEqual(len(calls), 1)
                payload = calls[0]
                self.assertIn(account, json.dumps(payload))
                self.assertIn("english", payload.get("instructions", "").lower())
                content = payload["input"][0]["content"]
                images = [part for part in content if part.get("type") == "input_image"]
                self.assertEqual(len(images), 1)
                self.assertTrue(images[0]["image_url"].startswith("data:image/jpeg;base64,"))
                self.assertNotIn("sk-test-", json.dumps(payload))
                self.assertNotIn("sk-test-", self.page.evaluate("JSON.stringify(Object.assign({}, localStorage))"))
                self.assertNotIn("sk-test-", self.page.evaluate("JSON.stringify(Object.assign({}, sessionStorage))"))
                self.page.unroute("https://api.openai.com/v1/responses")

    def test_05_caption_error_keeps_completed_work_and_retry_resumes(self):
        calls = self.mock_captions([200, 429, 200, 200])
        self.upload()
        self.page.locator("#order-mode").select_option("PUBLICATION")
        self.page.locator("#account-type").select_option("hotel")
        self.connect_key()
        self.page.locator("#generate-captions").click()
        expect(self.page.locator("#status")).to_contain_text("429", timeout=10000)
        self.assertEqual(len(calls), 2)
        self.assertIn("English caption", self.cards.nth(0).locator('textarea[data-field="caption"]').input_value())
        self.assertEqual(self.cards.nth(1).locator('textarea[data-field="caption"]').input_value(), "")
        self.assertNotIn("sensitive-key-never-display", self.page.locator("#status").inner_text())
        self.cards.nth(0).locator('textarea[data-field="caption"]').fill("My reviewed caption.")
        self.page.locator("#generate-captions").click()
        expect(self.cards.nth(2).locator('textarea[data-field="caption"]')).to_have_value(re.compile("English caption"), timeout=10000)
        self.assertEqual(len(calls), 4)
        self.assertEqual(self.cards.nth(0).locator('textarea[data-field="caption"]').input_value(), "My reviewed caption.")

    def test_06_key_and_uploaded_photos_do_not_persist_after_reload(self):
        self.upload([self.images[0]])
        self.connect_key()
        self.page.reload(wait_until="load")
        expect(self.cards).to_have_count(0)
        self.assertEqual(self.page.locator("#api-key").input_value(), "")

    def test_07_mobile_layout_stays_within_viewport(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.upload()
        self.assertLessEqual(
            self.page.evaluate("document.documentElement.scrollWidth"),
            self.page.evaluate("window.innerWidth") + 1,
        )
        self.page.screenshot(path=str(ARTIFACTS / "mobile.png"), full_page=True)
        self.page.set_viewport_size({"width": 1440, "height": 1050})
        self.page.screenshot(path=str(ARTIFACTS / "desktop.png"), full_page=True)

    def test_08_instagram_preview_tracks_both_modes_and_always_has_three_columns(self):
        self.upload()
        expect(self.page.locator("#grid-preview-section")).to_be_visible()
        self.page.locator("#order-mode").select_option("GRID")
        self.assertEqual(self.preview_names(), [path.name for path in self.images])
        self.assertEqual(self.page.locator("#grid-preview span").all_text_contents(), ["03", "02", "01"])
        self.page.locator("#order-mode").select_option("PUBLICATION")
        self.assertEqual(self.preview_names(), [path.name for path in reversed(self.images)])
        self.assertEqual(self.page.locator("#grid-preview span").all_text_contents(), ["03", "02", "01"])
        for width in [1440, 390]:
            self.page.set_viewport_size({"width": width, "height": 900})
            columns = self.page.locator("#grid-preview").evaluate("element => getComputedStyle(element).gridTemplateColumns")
            self.assertEqual(len(columns.split()), 3, f"Expected Instagram's 3 columns at {width}px: {columns}")

    def test_09_arrow_reorder_updates_preview_and_the_exported_image_order(self):
        self.upload()
        self.page.locator("#order-mode").select_option("GRID")
        self.cards.nth(0).get_by_role("button", name="Déplacer après : 01.jpg", exact=True).click()
        self.assertEqual(self.preview_names(), ["02.jpg", "01.jpg", "03.jpg"])
        by_name = {image.name: image.read_bytes() for image in self.images}
        for mode in ["GRID", "PUBLICATION"]:
            self.page.locator("#order-mode").select_option(mode)
            expected_publication = [by_name[name] for name in reversed(self.preview_names())]
            result = self.download_doc(f"reordered-{mode.lower()}.docx")
            self.assertEqual(result["media"], expected_publication)
            self.assertEqual(result["page_breaks"], 2)

    def test_10_duplicate_image_with_a_new_filename_is_ignored(self):
        self.upload([self.images[0]])
        self.file_picker().set_input_files({
            "name": "renamed-copy.jpg",
            "mimeType": "image/jpeg",
            "buffer": self.images[0].read_bytes(),
        })
        expect(self.page.locator("#status")).to_contain_text("1 doublon", timeout=10000)
        expect(self.cards).to_have_count(1)
        self.assertEqual(self.preview_names(), ["01.jpg"])
        result = self.download_doc("duplicate-ignored.docx")
        self.assertEqual(result["media"], [self.images[0].read_bytes()])
        self.assertEqual(result["page_breaks"], 0)

    def test_11_fake_jpeg_is_rejected_without_a_card_or_export(self):
        self.file_picker().set_input_files({
            "name": "pretend.jpg",
            "mimeType": "image/jpeg",
            "buffer": b"This is text, not image data.",
        })
        expect(self.page.locator("#status")).to_have_attribute("data-kind", "error", timeout=10000)
        expect(self.page.locator("#status")).to_contain_text("pretend.jpg")
        expect(self.cards).to_have_count(0)
        expect(self.page.locator("#export-doc")).to_be_disabled()
        expect(self.page.locator("#grid-preview-section")).to_be_hidden()

    def test_12_connected_canva_import_creates_doc_before_vision_and_syncs_stable_ids(self):
        backend = self.load_connected_mode()
        vision = self.mock_captions()
        self.start_canva_import()
        expect(self.page.locator("#native-document")).to_be_visible(timeout=10000)
        expect(self.page.locator("#native-document-link")).to_have_attribute(
            "href", "https://docs.google.com/document/d/doc123/edit")
        expect(self.cards).to_have_count(3)
        self.assertEqual(vision, [], "Canva import must not automatically generate captions")
        imported = next(call for call in backend if call["path"] == "/api/import")
        self.assertEqual(imported["body"], {"url": "https://www.canva.com/design/DAExample/edit", "orderMode": "GRID", "title": "Canva feed"})
        self.assertEqual(imported["headers"].get("x-csrf-token"), "test-csrf")
        for index in range(3):
            card = self.cards.nth(index)
            self.assertEqual(card.get_attribute("data-post-id"), f"p{index + 1}")
            expect(card.locator('textarea[data-field="caption"]')).to_have_value("")
            expect(card.locator('textarea[data-field="hashtags"]')).to_have_value("")
            expect(card.locator(".remove-button")).to_be_disabled()
            for button in card.locator(".move-controls button").all():
                expect(button).to_be_disabled()
        expect(self.page.locator("#order-mode")).to_be_disabled()
        expect(self.page.locator("#photo-input")).to_be_disabled()
        expect(self.page.locator("#account-type")).to_be_enabled()
        expect(self.page.locator("#sync-google-doc")).to_be_disabled()

        self.page.locator("#account-type").select_option("restaurant")
        self.connect_key()
        self.page.locator("#generate-captions").click()
        expect(self.cards.nth(0).locator('textarea[data-field="caption"]')).to_have_value(re.compile("English caption"), timeout=10000)
        self.assertEqual(len(vision), 3)
        self.assertTrue(all("restaurant" in json.dumps(payload) for payload in vision))
        expected_posts = [{"id": f"p{index + 1}",
                           "caption": self.cards.nth(index).locator('textarea[data-field="caption"]').input_value(),
                           "hashtags": self.cards.nth(index).locator('textarea[data-field="hashtags"]').input_value()}
                          for index in range(3)]
        expect(self.page.locator("#sync-google-doc")).to_be_enabled()
        self.page.locator("#sync-google-doc").click()
        expect(self.page.locator("#canva-status")).to_contain_text("Textes envoyés", timeout=10000)
        synced = next(call for call in backend if call["path"] == "/api/jobs/job123/captions")
        self.assertEqual(synced["body"], {"posts": expected_posts})
        self.assertEqual(synced["headers"].get("x-csrf-token"), "test-csrf")
        for card in self.cards.all():
            expect(card.locator('textarea[data-field="caption"]')).to_be_disabled()
            expect(card.locator('textarea[data-field="hashtags"]')).to_be_disabled()
        self.assertNotIn("test-csrf", self.page.locator("body").inner_text())
        self.assertEqual(self.page.locator('input[id*="client-secret"],input[name*="client_secret"],input[id*="access-token"]').count(), 0)
        self.page.screenshot(path=str(ARTIFACTS / "connected-synced.png"), full_page=True)

    def test_13_unconfigured_server_disables_connections_and_import(self):
        backend = self.load_connected_mode(configured=False)
        expect(self.page.locator("#connect-canva")).to_be_disabled()
        expect(self.page.locator("#connect-google")).to_be_disabled()
        expect(self.page.locator("#canva-import")).to_be_disabled()
        expect(self.page.locator("#native-document")).to_be_hidden()
        self.assertEqual([call["path"] for call in backend], ["/api/session"])

    def test_14_failed_canva_job_does_not_claim_a_google_document(self):
        self.load_connected_mode(job_error="Canva export refused for this design.")
        self.start_canva_import()
        expect(self.page.locator("#canva-status")).to_contain_text("Canva export refused", timeout=10000)
        expect(self.page.locator("#native-document")).to_be_hidden()
        expect(self.page.locator("#native-document-link")).not_to_have_attribute("href", re.compile("docs.google.com"))
        expect(self.cards).to_have_count(0)
        expect(self.page.locator("#canva-import")).to_be_enabled()

    def test_15_manual_caption_enables_connected_sync_and_locks_only_synced_fields(self):
        backend = self.load_connected_mode()
        self.start_canva_import()
        expect(self.cards).to_have_count(3)
        expect(self.page.locator("#native-document")).to_be_visible()
        expect(self.page.locator("#sync-google-doc")).to_be_disabled()
        self.cards.nth(0).locator('textarea[data-field="caption"]').fill("A reviewed caption written by hand.")
        expect(self.page.locator("#sync-google-doc")).to_be_enabled()
        self.page.locator("#sync-google-doc").click()
        expect(self.page.locator("#canva-status")).to_contain_text("Textes envoyés", timeout=10000)
        synced = next(call for call in backend if call["path"] == "/api/jobs/job123/captions")
        self.assertEqual(synced["body"]["posts"][0], {"id": "p1", "caption": "A reviewed caption written by hand.", "hashtags": ""})
        expect(self.cards.nth(0).locator('textarea[data-field="caption"]')).to_be_disabled()
        expect(self.cards.nth(0).locator('textarea[data-field="hashtags"]')).to_be_enabled()
        expect(self.cards.nth(1).locator('textarea[data-field="caption"]')).to_be_enabled()

    def test_16_server_caption_generation_needs_no_browser_key_and_sends_only_context_and_owned_ids(self):
        self.context.add_cookies([{"name": "feed_test_session", "value": "test-browser-session", "url": self.url}])
        backend = self.load_connected_mode(openai=True)
        direct_vision = self.mock_captions()
        self.page.locator(".ai-settings").evaluate("element => { element.open = true; }")
        expect(self.page.locator("#server-ai-status")).to_contain_text("Aucune clé à saisir")
        expect(self.page.locator("#api-key")).to_be_hidden()
        expect(self.page.locator("#ai-model")).to_be_hidden()
        self.start_canva_import()
        expect(self.cards).to_have_count(3)
        self.page.locator(".ai-settings").evaluate("element => { element.open = true; }")
        expect(self.page.locator("#server-ai-status")).to_contain_text("Aucune clé à saisir")
        expect(self.page.locator("#api-key")).to_be_hidden()
        expect(self.page.locator("#ai-model")).to_be_hidden()
        self.assertEqual(self.page.locator("#api-key").input_value(), "")
        self.page.locator("#account-type").select_option("restaurant")
        self.page.locator("#brand-name").fill("Café du Jardin")
        self.page.locator("#brand-brief").fill("A family restaurant with a confirmed courtyard.")
        self.page.locator("#tone").select_option("Vivid and appetizing, without exaggeration")
        self.page.locator("#required-hashtags").fill("#CafeDuJardin #LocalTable")
        for index in range(3):
            self.cards.nth(index).locator("details").evaluate("element => { element.open = true; }")
            self.cards.nth(index).locator('textarea[data-field="facts"]').fill("Confirmed photo fact " + str(index + 1))

        self.page.locator("#generate-captions").click()
        expect(self.cards.nth(0).locator('textarea[data-field="caption"]')).to_have_value("Server English caption for p1.", timeout=10000)
        generated = [call for call in backend if call["path"].endswith("/generate-caption")]
        self.assertEqual([call["body"]["imageId"] for call in generated], ["p3", "p2", "p1"])
        for call in generated:
            self.assertEqual(set(call["body"]), {"imageId", "context"})
            context = call["body"]["context"]
            self.assertEqual(set(context), {"accountType", "brand", "verifiedDetails", "photoFacts", "tone", "requiredHashtags", "recentCaptions"})
            self.assertEqual(context["accountType"], "restaurant")
            self.assertEqual(context["brand"], "Café du Jardin")
            self.assertEqual(context["verifiedDetails"], "A family restaurant with a confirmed courtyard.")
            self.assertEqual(context["photoFacts"], "Confirmed photo fact " + call["body"]["imageId"][1:])
            self.assertEqual(context["tone"], "Vivid and appetizing, without exaggeration")
            self.assertEqual(context["requiredHashtags"], ["#CafeDuJardin", "#LocalTable"])
            self.assertLessEqual(len(context["recentCaptions"]), 3)
            self.assertEqual(call["headers"].get("x-csrf-token"), "test-csrf")
            self.assertIn("feed_test_session=test-browser-session", call["headers"].get("cookie", ""))
            self.assertNotIn("authorization", call["headers"])
            serialized = json.dumps(call["body"])
            for forbidden in ["base64", "image_url", "gpt-", "sk-"]:
                self.assertNotIn(forbidden, serialized)
        self.assertEqual(generated[0]["body"]["context"]["recentCaptions"], [])
        self.assertIn("Server English caption for p3.", generated[1]["body"]["context"]["recentCaptions"])
        self.assertEqual(direct_vision, [])
        self.assertFalse(any("api.openai.com" in url for url in self.requests))
        self.assertEqual(self.page.locator("#api-key").input_value(), "")
        expect(self.page.locator("#sync-google-doc")).to_be_enabled()

    def test_17_server_caption_error_keeps_completed_work_and_retry_skips_reviewed_captions(self):
        backend = self.load_connected_mode(openai=True, generation_statuses=[200, 503, 200, 200])
        self.start_canva_import()
        expect(self.cards).to_have_count(3)
        self.page.locator("#generate-captions").click()
        expect(self.page.locator("#status")).to_contain_text("temporarily unavailable", timeout=10000)
        expect(self.cards.nth(2).locator('textarea[data-field="caption"]')).to_have_value("Server English caption for p3.")
        expect(self.cards.nth(1).locator('textarea[data-field="caption"]')).to_have_value("")
        self.cards.nth(2).locator('textarea[data-field="caption"]').fill("My reviewed restaurant caption.")
        self.page.locator("#generate-captions").click()
        expect(self.cards.nth(0).locator('textarea[data-field="caption"]')).to_have_value("Server English caption for p1.", timeout=10000)
        generated = [call for call in backend if call["path"].endswith("/generate-caption")]
        self.assertEqual([call["body"]["imageId"] for call in generated], ["p3", "p2", "p2", "p1"])
        expect(self.cards.nth(2).locator('textarea[data-field="caption"]')).to_have_value("My reviewed restaurant caption.")
        self.assertEqual(self.page.locator("#api-key").input_value(), "")
        self.assertFalse(any("api.openai.com" in url for url in self.requests))

    def test_18_stopping_server_generation_aborts_the_request_and_allows_resume(self):
        backend = self.load_connected_mode(openai=True)
        self.start_canva_import()
        expect(self.cards).to_have_count(3)
        self.cards.nth(2).locator('textarea[data-field="caption"]').fill("A caption reviewed before generation.")
        self.page.evaluate("""() => {
            window.fetchBeforeStopTest = window.fetch;
            window.stoppedGenerationSignal = null;
            window.fetch = function (path, options) {
                if (String(path).endsWith('/generate-caption')) {
                    window.stoppedGenerationSignal = options && options.signal;
                    return new Promise((resolve, reject) => {
                        if (!window.stoppedGenerationSignal) {
                            reject(new Error('Missing generation AbortSignal'));
                            return;
                        }
                        window.stoppedGenerationSignal.addEventListener('abort', () => {
                            reject(new DOMException('Stopped by user', 'AbortError'));
                        }, {once: true});
                    });
                }
                return window.fetchBeforeStopTest.apply(this, arguments);
            };
        }""")
        self.page.locator("#generate-captions").click()
        self.page.wait_for_function("window.stoppedGenerationSignal !== null")
        expect(self.page.locator("#stop-generation")).to_be_visible()
        self.page.locator("#stop-generation").click()
        expect(self.page.locator("#status")).to_contain_text("arrêté", timeout=10000)
        self.assertTrue(self.page.evaluate("window.stoppedGenerationSignal.aborted"))
        expect(self.page.locator("#generate-captions")).to_be_enabled()
        expect(self.cards.nth(0).locator('textarea[data-field="caption"]')).to_have_value("")
        expect(self.cards.nth(1).locator('textarea[data-field="caption"]')).to_have_value("")
        expect(self.cards.nth(2).locator('textarea[data-field="caption"]')).to_have_value("A caption reviewed before generation.")
        self.assertFalse(any(call["path"].endswith("/generate-caption") for call in backend))

        self.page.evaluate("window.fetch = window.fetchBeforeStopTest")
        self.page.locator("#generate-captions").click()
        expect(self.cards.nth(0).locator('textarea[data-field="caption"]')).to_have_value("Server English caption for p1.", timeout=10000)
        generated = [call for call in backend if call["path"].endswith("/generate-caption")]
        self.assertEqual([call["body"]["imageId"] for call in generated], ["p2", "p1"])
        expect(self.cards.nth(2).locator('textarea[data-field="caption"]')).to_have_value("A caption reviewed before generation.")

    def test_19_leaving_native_feed_restores_browser_key_generation_for_manual_photos(self):
        backend = self.load_connected_mode(openai=True)
        self.start_canva_import()
        expect(self.cards).to_have_count(3)
        self.page.locator(".ai-settings").evaluate("element => { element.open = true; }")
        expect(self.page.locator("#api-key")).to_be_hidden()
        self.page.locator("#new-canva-feed").click()
        expect(self.cards).to_have_count(0)
        expect(self.page.locator("#server-ai-status")).to_be_visible()
        expect(self.page.locator("#api-key")).to_be_hidden()
        expect(self.page.locator("#ai-model")).to_be_hidden()
        self.upload([self.images[0]])
        expect(self.page.locator("#server-ai-status")).to_be_hidden()
        expect(self.page.locator("#api-key")).to_be_visible()
        expect(self.page.locator("#ai-model")).to_be_visible()
        direct_vision = self.mock_captions()
        self.connect_key()
        self.page.locator("#generate-captions").click()
        expect(self.cards.nth(0).locator('textarea[data-field="caption"]')).to_have_value(re.compile("English caption"), timeout=10000)
        self.assertEqual(len(direct_vision), 1)
        self.assertFalse(any(call["path"].endswith("/generate-caption") for call in backend))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=APP)
    parser.add_argument("--artifacts", type=Path, default=ARTIFACTS)
    parser.add_argument("--file-url", action="store_true", help="Test direct file opening instead of temporary local HTTP")
    args, remaining = parser.parse_known_args()
    APP = args.app.resolve()
    ARTIFACTS = args.artifacts.resolve()
    FILE_URL = args.file_url
    if not APP.is_file():
        parser.error(f"Standalone app not built: {APP}")
    if not (shutil.which("chromium") or shutil.which("google-chrome")):
        parser.error("Chromium or Google Chrome is required")
    print(f"Browser artifacts: {ARTIFACTS}", flush=True)
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
