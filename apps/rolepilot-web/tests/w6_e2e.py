"""User-run W6 E2E: real HTTP/Storage/workers, replay provider, no route mocks."""
import json
import os
from pathlib import Path
import queue
import subprocess
import threading

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
messages = queue.Queue()
manager = subprocess.Popen(
    [os.environ.get("ROLEPILOT_TEST_NODE", "node"), str(ROOT / "scripts/web-acceptance/serve.mjs"), "--json", "--new"],
    cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)


def collect():
    for line in manager.stdout:
        try:
            messages.put(json.loads(line))
        except json.JSONDecodeError:
            pass
    messages.put({"type": "closed"})


threading.Thread(target=collect, daemon=True).start()


def receive(kind):
    value = messages.get(timeout=120)
    assert value.get("type") == kind, f"验收进程未返回 {kind}"
    return value


def command(value):
    manager.stdin.write(json.dumps(value) + "\n")
    manager.stdin.flush()


def create(page, info, company):
    page.goto(info["webUrl"] + "/new")
    page.get_by_label("本地简历文件输入").set_input_files(info["resumeFile"])
    page.get_by_label("公司名称", exact=True).fill(company)
    page.get_by_label("目标岗位", exact=True).fill("Platform Engineer")
    page.locator("#target-jd-text").fill(info["jdText"])
    submit = page.get_by_role("button", name="开始分析与改写", exact=True)
    expect(submit).to_be_enabled(timeout=120000)
    submit.click()
    page.wait_for_url("**/runs/*")
    page.reload()
    return page.url.rsplit("/", 1)[1]


def status(page, value):
    expect(page.locator(".run-status")).to_have_text(value, timeout=120000)


try:
    info = receive("ready")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            with browser.new_context() as context:
                page = context.new_page()
                run_id = create(page, info, "W6 normal")
                status(page, "COMPLETED")
                page.wait_for_url("**/workbench/*", timeout=60000)
                assert context.request.get(info["apiUrl"] + "/api/runs/" + run_id + "/workbench").status == 200
                response = context.request.delete(
                    info["apiUrl"] + "/api/runs/" + run_id,
                    headers={"x-rolepilot-confirm": "DELETE_RUN"},
                )
                assert response.status == 202
                assert context.request.get(info["apiUrl"] + "/api/runs/" + run_id).status == 404
                command({"type": "check-cleaned", "runId": run_id})
                receive("cleaned")
            print("PASS 正常闭环：上传、完成自动进入工作台、删除和后端清理")

            with browser.new_context() as context:
                page = context.new_page()
                run_id = create(page, info, "W6 evidence")
                status(page, "NEEDS_USER_INPUT")
                command({"type": "restart-evidence", "runId": run_id})
                receive("restarted")
                page.reload()
                status(page, "NEEDS_USER_INPUT")
                page.get_by_placeholder("补充证据", exact=True).fill(info["evidenceText"])
                page.get_by_role("button", name="提交补充", exact=True).click()
                status(page, "COMPLETED")
                page.wait_for_url("**/workbench/*", timeout=60000)
            print("PASS 补证闭环：删除本地目录、重启、刷新、同一 Run 完成并进入工作台")

            with browser.new_context() as context:
                page = context.new_page()
                run_id = create(page, info, "W6 cancel")
                status(page, "RUNNING")
                page.reload()
                page.get_by_role("button", name="取消运行", exact=True).click()
                status(page, "CANCELLED")
                command({"type": "wait-idle", "runId": run_id})
                receive("idle")
                page.reload()
                status(page, "CANCELLED")
                expect(page.locator(".run-export-actions")).to_have_count(0)
            print("PASS 取消闭环：刷新、取消、Worker 收尾后终态保持")
        finally:
            browser.close()
    print("三条浏览器流程通过；工作台双稿展示、建议定位与浏览器打印 PDF 由人工检查。")
finally:
    if manager.poll() is None:
        try:
            command({"type": "quit"})
            manager.wait(timeout=30)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            manager.terminate()
            try:
                manager.wait(timeout=10)
            except subprocess.TimeoutExpired:
                manager.kill()
                manager.wait()
