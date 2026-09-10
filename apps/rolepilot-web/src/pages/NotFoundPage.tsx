import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="static-page" aria-labelledby="not-found-title">
      <p className="eyebrow">404</p>
      <h1 id="not-found-title">页面不存在</h1>
      <Link className="button button-primary" to="/">
        返回任务
      </Link>
    </section>
  );
}
