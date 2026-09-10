from playwright.sync_api import expect, sync_playwright


BASE_URL = "http://127.0.0.1:4173"
VIEWPORTS = [(375, 812), (390, 844), (768, 1024), (1024, 768), (1440, 900)]


def assert_no_horizontal_overflow(page):
    assert not page.evaluate("document.documentElement.scrollWidth > window.innerWidth")


def assert_focus_ring(page):
    page.get_by_role("button", name="选择简历文件").focus()
    assert page.evaluate("document.activeElement?.getAttribute('aria-label')") == "选择简历文件"
    outline = page.get_by_role("button", name="选择简历文件").evaluate(
        "element => getComputedStyle(element).outlineStyle"
    )
    assert outline != "none", "键盘焦点没有可见焦点环"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.goto(f"{BASE_URL}/new", wait_until="networkidle")
            expect(page.get_by_role("heading", name="创建优化任务")).to_be_visible()
            expect(page.get_by_role("region", name="本次流程")).to_be_visible()
            expect(page.get_by_role("button", name="选择简历文件")).to_be_visible()
            expect(page.get_by_label("公司名称")).to_be_visible()
            expect(page.get_by_label("目标岗位")).to_be_visible()
            expect(page.get_by_label("岗位描述（JD）")).to_be_visible()
            expect(page.get_by_role("button", name="开始分析与改写")).to_be_disabled()
            assert_no_horizontal_overflow(page)
            page.close()

        page = browser.new_page(viewport={"width": 390, "height": 844}, reduced_motion="reduce")
        page.goto(f"{BASE_URL}/new", wait_until="networkidle")
        assert_focus_ring(page)
        page.get_by_role("link", name="跳到主要内容").focus()
        assert page.evaluate("document.activeElement?.classList.contains('skip-link')")
        animation_names = page.locator("*").evaluate_all(
            "elements => elements.map(element => getComputedStyle(element).animationName)"
        )
        assert all(name in ("none", "") for name in animation_names)
        assert_no_horizontal_overflow(page)
        page.close()

        # 640 CSS px approximates a 1280px viewport rendered at 200% browser zoom.
        zoomed = browser.new_page(viewport={"width": 640, "height": 900})
        zoomed.goto(f"{BASE_URL}/new", wait_until="networkidle")
        assert_no_horizontal_overflow(zoomed)
        expect(zoomed.get_by_role("button", name="开始分析与改写")).to_be_disabled()
        zoomed.close()
    finally:
        browser.close()
