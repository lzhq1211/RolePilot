import json
import os
import time
from pathlib import Path

from playwright.sync_api import Route, expect, sync_playwright


BASE_URL = os.environ.get("ROLEPILOT_WEB_URL", "http://127.0.0.1:4173")
VIEWPORTS = [(375, 812), (390, 844), (768, 1024), (1024, 768), (1440, 900)]
SCREENSHOT_DIR = Path("/tmp/rolepilot-w2")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
CREATE_REQUEST_COUNT = 0


def source_payload(source_id: str, input_kind: str, file_name: str | None = None):
    return {
        "id": source_id,
        "status": "READY",
        "inputKind": input_kind,
        "originalFileName": file_name,
        "mediaType": "text/plain",
        "sizeBytes": 40,
        "textLength": 28,
        "pageCount": None,
        "previewText": "可审计的简历正文。",
        "parserVersion": "document-ingest/pdf-v1",
        "error": None,
        "createdAt": "2026-09-04T00:00:00.000Z",
        "updatedAt": "2026-09-04T00:00:00.000Z",
    }


def failed_source_payload():
    payload = source_payload("failed-source", "file", "broken.txt")
    payload["status"] = "FAILED"
    payload["textLength"] = None
    payload["previewText"] = None
    payload["parserVersion"] = None
    payload["error"] = {
        "code": "EMPTY_DOCUMENT",
        "message": "文档没有可用正文。",
        "retryable": False,
    }
    return payload


def fulfill_source(route: Route):
    global CREATE_REQUEST_COUNT

    request = route.request
    assert request.method == "POST"
    assert request.header_value("x-request-id")
    assert request.header_value("idempotency-key")
    CREATE_REQUEST_COUNT += 1

    if CREATE_REQUEST_COUNT == 1:
        time.sleep(0.35)
    if CREATE_REQUEST_COUNT == 2:
        route.fulfill(status=201, content_type="application/json", body=json.dumps(failed_source_payload()))
        return
    if CREATE_REQUEST_COUNT == 3:
        payload = source_payload("keyboard-source", "file", "keyboard.txt")
    elif CREATE_REQUEST_COUNT == 4:
        payload = source_payload("dropped-source", "file", "drop.txt")
    elif CREATE_REQUEST_COUNT == 5:
        payload = source_payload("pasted-source", "pasted-text")
    else:
        payload = source_payload("uploaded-source", "file", "resume.txt")
    route.fulfill(status=201, content_type="application/json", body=json.dumps(payload))


def assert_no_horizontal_overflow(page):
    overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
    assert not overflow, "页面出现横向滚动"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.route("**/api/resume-sources", fulfill_source)
            page.goto(f"{BASE_URL}/new", wait_until="networkidle")
            assert page.get_by_role("heading", name="简历来源").is_visible()
            assert page.get_by_role("button", name="选择简历文件").is_visible()
            assert page.get_by_label("本地简历文件输入").get_attribute("accept") == ".pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,text/plain"
            assert_no_horizontal_overflow(page)
            page.screenshot(path=str(SCREENSHOT_DIR / f"new-empty-{width}x{height}.png"), full_page=True)
            page.close()

        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.route("**/api/resume-sources", fulfill_source)
        page.goto(f"{BASE_URL}/new", wait_until="networkidle")

        with page.expect_file_chooser() as chooser_info:
            page.get_by_role("button", name="选择简历文件").click()
        chooser_info.value.set_files(
            {"name": "resume.txt", "mimeType": "text/plain", "buffer": b"Evidence-backed resume text."}
        )
        expect(page.get_by_text("正在解析", exact=True)).to_be_visible()
        expect(page.get_by_text("简历可用", exact=True)).to_be_visible()
        expect(page.locator(".source-dropzone-detail")).to_contain_text("resume.txt")
        expect(page.locator(".source-dropzone-detail")).to_contain_text("28 字")

        with page.expect_file_chooser() as chooser_info:
            page.get_by_role("button", name="选择简历文件").focus()
            page.keyboard.press("Enter")
        chooser_info.value.set_files(
            {"name": "broken.txt", "mimeType": "text/plain", "buffer": b" "}
        )
        expect(page.get_by_role("alert")).to_contain_text("文档没有可用正文。")
        expect(page.locator(".source-dropzone-detail")).to_contain_text("resume.txt")

        with page.expect_file_chooser() as chooser_info:
            page.get_by_role("button", name="选择简历文件").focus()
            page.keyboard.press("Space")
        chooser_info.value.set_files(
            {"name": "keyboard.txt", "mimeType": "text/plain", "buffer": b"Keyboard source text."}
        )
        expect(page.locator(".source-dropzone-detail")).to_contain_text("keyboard.txt")

        page.locator("[data-source-dropzone]").evaluate(
            """element => {
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(new File(["Dropped source text."], "drop.txt", { type: "text/plain" }));
                element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
                element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
            }"""
        )
        expect(page.locator(".source-dropzone-detail")).to_contain_text("drop.txt")

        page.get_by_role("button", name="粘贴文本").click()
        page.get_by_role("textbox", name="粘贴简历正文").fill("Pasted source text.")
        page.get_by_role("button", name="解析并使用").click()
        expect(page.get_by_text("简历可用", exact=True)).to_be_visible()
        expect(page.locator(".source-paste-status-detail")).to_contain_text("粘贴的简历文本")
        assert_no_horizontal_overflow(page)
        page.screenshot(path=str(SCREENSHOT_DIR / "new-source-mobile.png"), full_page=True)
        page.close()
    finally:
        browser.close()
