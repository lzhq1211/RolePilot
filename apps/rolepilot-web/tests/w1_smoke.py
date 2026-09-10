from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:4173"
VIEWPORTS = [(375, 812), (390, 844), (768, 1024), (1024, 768), (1440, 900)]
SCREENSHOT_DIR = Path("/tmp/rolepilot-w1")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)


def assert_no_horizontal_overflow(page):
    overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
    assert not overflow, "页面出现横向滚动"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width, height in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height})
        page.goto(BASE_URL, wait_until="networkidle")
        assert_no_horizontal_overflow(page)
        assert page.get_by_role("heading", name="让每一次改写，都有证据可追。").is_visible()
        if width > 900:
            assert not page.get_by_role("button", name="打开导航菜单").is_visible()
        page.screenshot(path=str(SCREENSHOT_DIR / f"home-{width}x{height}.png"), full_page=True)
        page.close()

    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.goto(BASE_URL, wait_until="networkidle")
    page.get_by_role("button", name="打开导航菜单").click()
    assert page.get_by_role("complementary", name="导航菜单").is_visible()
    page.keyboard.press("Escape")
    assert not page.get_by_role("complementary", name="导航菜单").is_visible()
    assert page.locator(".scanner-hero a[href='/new']").get_attribute("href") == "/new"
    page.goto(f"{BASE_URL}/new", wait_until="networkidle")
    assert page.get_by_role("heading", name="创建优化任务").is_visible()
    assert page.get_by_role("region", name="本次流程").is_visible()
    assert_no_horizontal_overflow(page)
    page.screenshot(path=str(SCREENSHOT_DIR / "new-mobile.png"), full_page=True)
    page.close()

    reduced = browser.new_page(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
    reduced.goto(f"{BASE_URL}/new", wait_until="networkidle")
    assert_no_horizontal_overflow(reduced)
    assert reduced.locator(".scanner canvas").count() == 1
    reduced.screenshot(path=str(SCREENSHOT_DIR / "new-reduced-motion.png"), full_page=True)
    reduced.close()
    browser.close()
