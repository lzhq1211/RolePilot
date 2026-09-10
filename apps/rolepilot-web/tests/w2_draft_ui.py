import json
import time

from playwright.sync_api import Route, expect, sync_playwright


BASE_URL = "http://127.0.0.1:4173"
draft = {
    "id": "00000000-0000-4000-8000-000000000001",
    "resumeSourceId": "source-1",
    "company": "RolePilot",
    "title": "AI 产品经理",
    "jdText": "负责证据驱动的简历优化。",
    "revision": 1,
    "updatedAt": "2026-09-04T00:00:00.000Z",
}
create_count = 0
update_count = 0


def source_payload():
    return {
        "id": "source-1",
        "status": "READY",
        "inputKind": "file",
        "originalFileName": "resume.txt",
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


def json_response(route: Route, payload, status=200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(payload))


def api_route(route: Route):
    global create_count, update_count, draft

    request = route.request
    path = request.url.split("/api", 1)[1].split("?", 1)[0]
    if path == "/resume-sources" and request.method == "POST":
        json_response(route, source_payload(), 201)
        return
    if path == "/resume-sources/source-1" and request.method == "GET":
        json_response(route, source_payload())
        return
    if path == "/input-drafts" and request.method == "POST":
        create_count += 1
        body = json.loads(request.post_data or "{}")
        draft = {**draft, **body, "revision": 1}
        json_response(route, draft, 201)
        return
    if path == f"/input-drafts/{draft['id']}" and request.method == "GET":
        json_response(route, draft)
        return
    if path == f"/input-drafts/{draft['id']}" and request.method == "PUT":
        update_count += 1
        assert request.header_value("if-match") == str(draft["revision"])
        body = json.loads(request.post_data or "{}")
        draft = {**draft, **body, "revision": draft["revision"] + 1}
        json_response(route, draft)
        return
    route.continue_()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.route("**/api/**", api_route)
    page.goto(f"{BASE_URL}/new", wait_until="networkidle")

    with page.expect_file_chooser() as chooser_info:
        page.get_by_role("button", name="选择简历文件").click()
    chooser_info.value.set_files(
        {"name": "resume.txt", "mimeType": "text/plain", "buffer": b"Resume source text."}
    )
    expect(page.get_by_text("简历可用", exact=True)).to_be_visible()

    page.get_by_role("textbox", name="公司名称").fill("RolePilot")
    page.get_by_label("目标岗位").fill("AI 产品经理")
    page.get_by_label("岗位描述（JD）").fill("负责证据驱动的简历优化。")
    page.wait_for_timeout(600)
    expect(page.get_by_text("已保存", exact=True)).to_be_visible()
    assert create_count == 1, f"debounce 应只创建一次 Draft，实际为 {create_count} 次"
    assert "draft=" in page.url

    page.reload(wait_until="networkidle")
    expect(page.get_by_role("textbox", name="公司名称")).to_have_value("RolePilot")
    expect(page.get_by_label("目标岗位")).to_have_value("AI 产品经理")
    expect(page.get_by_label("岗位描述（JD）")).to_have_value("负责证据驱动的简历优化。")
    expect(page.get_by_text("简历可用", exact=True)).to_be_visible()

    company = page.get_by_role("textbox", name="公司名称")
    company.fill(" ")
    company.blur()
    expect(page.get_by_text("请输入公司名称。", exact=True)).to_be_visible()

    page.screenshot(path="/tmp/rolepilot-w2/new-draft-mobile.png", full_page=True)
    page.close()
    browser.close()
