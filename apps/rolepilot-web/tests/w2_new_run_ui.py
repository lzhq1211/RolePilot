import json

from playwright.sync_api import Route, expect, sync_playwright


BASE_URL = "http://127.0.0.1:4173"
draft = {
    "id": "00000000-0000-4000-8000-000000000001",
    "resumeSourceId": "source-1",
    "company": "",
    "title": "",
    "jdText": "",
    "revision": 1,
    "updatedAt": "2026-09-04T00:00:00.000Z",
}
run_requests = 0


def source_payload():
    return {
        "id": "source-1",
        "status": "READY",
        "inputKind": "file",
        "originalFileName": "resume.txt",
        "mediaType": "text/plain",
        "sizeBytes": 20,
        "textLength": 18,
        "pageCount": None,
        "previewText": "Evidence-backed resume.",
        "parserVersion": "document-ingest/txt-v1",
        "error": None,
        "createdAt": "2026-09-04T00:00:00.000Z",
        "updatedAt": "2026-09-04T00:00:00.000Z",
    }


def json_response(route: Route, payload, status=200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(payload))


def api_route(route: Route):
    global draft, run_requests

    request = route.request
    path = request.url.split("/api", 1)[1].split("?", 1)[0]
    if path == "/resume-sources" and request.method == "POST":
        json_response(route, source_payload(), 201)
        return
    if path == "/input-drafts" and request.method == "POST":
        body = json.loads(request.post_data or "{}")
        draft = {**draft, **body, "revision": 1}
        json_response(route, draft, 201)
        return
    if path == f"/input-drafts/{draft['id']}" and request.method == "GET":
        json_response(route, draft)
        return
    if path == f"/input-drafts/{draft['id']}" and request.method == "PUT":
        body = json.loads(request.post_data or "{}")
        draft = {**draft, **body, "revision": draft["revision"] + 1}
        json_response(route, draft)
        return
    if path.startswith("/runs"):
        run_requests += 1
        route.fulfill(status=500, content_type="application/json", body="{}")
        return
    route.continue_()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.route("**/api/**", api_route)
    page.goto(f"{BASE_URL}/new", wait_until="networkidle")

    submit = page.get_by_role("button", name="开始分析与改写")
    expect(submit).to_be_disabled()

    with page.expect_file_chooser() as chooser_info:
        page.get_by_role("button", name="选择简历文件").click()
    chooser_info.value.set_files(
        {"name": "resume.txt", "mimeType": "text/plain", "buffer": b"Evidence-backed resume."}
    )
    page.get_by_role("textbox", name="公司名称").fill("RolePilot")
    page.get_by_label("目标岗位").fill("AI 产品经理")
    page.get_by_label("岗位描述（JD）").fill("负责证据驱动的简历优化。")
    page.wait_for_timeout(600)
    expect(submit).to_be_enabled()

    submit.click()
    expect(page.get_by_role("status")).to_contain_text("Mock 已接收")
    assert run_requests == 0, "W2-07 不应请求 /api/runs"
    assert page.get_by_text("provider", exact=False).count() == 0
    assert page.get_by_text("includeInterview", exact=False).count() == 0
    page.close()
    browser.close()
