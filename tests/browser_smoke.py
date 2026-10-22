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
from urllib.parse import quote

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
