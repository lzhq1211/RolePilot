import { Menu, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { workbenchHref } from "../workbench-link";

const navItems = [
  { to: "/", label: "任务" },
  { to: "/new", label: "新建" },
  { to: "/settings", label: "设置" },
];

export function Shell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const isHome = location.pathname === "/";

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawerRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      menuButtonRef.current?.focus();
    };
  }, [drawerOpen]);

  return (
    <>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="studio-top-pill">
        <nav className="studio-top-pill-nav" aria-label="主导航">
          <div className="pill-left">
            <NavLink className="nav-logo" to="/" aria-label="RolePilot 首页">
              ROLEPILOT
              <span aria-hidden="true" />
            </NavLink>
          </div>
          <div className="pill-actions">
            <NavLink className="btn-pill-white" to="/settings">设置</NavLink>
            <button className="btn-pill-white" type="button" disabled title="登录尚未开放">登录</button>
            <NavLink className="btn-pill-soft" to="/new">新建优化<span aria-hidden="true">→</span></NavLink>
            <a className="btn-pill-soft" href={workbenchHref()}>进入排版工作台<span aria-hidden="true">→</span></a>
          </div>
          <button
            ref={menuButtonRef}
            className="bionova-menu-button"
            type="button"
            aria-label="打开导航菜单"
            aria-expanded={drawerOpen}
            aria-controls="mobile-navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden="true" />
          </button>
        </nav>
      </header>
      <main id="main-content" className={isHome ? "app-main app-main--home" : "page-container page-content"}>
        {children}
      </main>
      {drawerOpen && (
        <div className="drawer-layer" role="presentation">
          <button className="drawer-backdrop" aria-label="关闭导航菜单" type="button" onClick={() => setDrawerOpen(false)} />
          <aside ref={drawerRef} id="mobile-navigation" className="mobile-drawer" aria-label="导航菜单">
            <button className="icon-button drawer-close" type="button" aria-label="关闭导航菜单" title="关闭" onClick={() => setDrawerOpen(false)}>
              <X aria-hidden="true" />
            </button>
            {navItems.map((item) => (
              <NavLink key={item.to} to={item.to} className="drawer-link" onClick={() => setDrawerOpen(false)}>
                {item.label}
              </NavLink>
            ))}
            <a className="drawer-link" href={workbenchHref()} onClick={() => setDrawerOpen(false)}>
              排版工作台
            </a>
          </aside>
        </div>
      )}
    </>
  );
}
