import { Link } from "react-router-dom";
import { HeroVideo } from "../components/HeroVideo";
import { workbenchHref } from "../workbench-link";

export function HomePage() {
  return (
    <section className="home-page bionova-home">
      <div className="hero-container">
        <div className="content-area">
          <div className="hero-grid">
            <div className="left-col animate-fade-up">
              <div className="left-top-group">
                <h1 className="hero-h1">
                  <span className="h1-line"><span className="inline-img-pill" />AI-Native</span>
                  <span className="h1-line">resume engine that</span>
                  <span className="h1-line">empowers</span>
                  <span className="h1-line">career transitions.</span>
                </h1>
                <div className="hero-cta-group">
                  <Link className="btn-pill-soft hero-cta" to="/new">
                    立即重构我的简历
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="7" y1="17" x2="17" y2="7" />
                      <polyline points="7 7 17 7 17 17" />
                    </svg>
                  </Link>
                  <a className="btn-pill-white hero-cta" href={workbenchHref()}>前往工作台</a>
                </div>
              </div>
            </div>

            <div className="right-col animate-fade-up delay-150">
              <article className="card card-top">
                <HeroVideo className="card-video" source="https://stream.mux.com/1RdbcBtpEUK6501pc6yaIvwo9UfSnOg02k1uHxat00xR3w.m3u8" />
                <div className="card-overlay" />
                <div className="card-content">
                  <h2 className="card-top-title">让每一句经历表述，都有真实证据链严谨支撑。</h2>
                  <div className="card-top-footer">
                    <p className="card-top-desc">多轮 Agent 深度推演，自动剔除无依据虚假主张，重构最具说服力的高薪定位。</p>
                  </div>
                </div>
              </article>

              <div className="cards-bottom-row">
                <article className="card card-2">
                  <HeroVideo className="card-video" source="https://stream.mux.com/t1TbTB8M1VYHkhxBuap4A8Vm1x015HTHyuQxqchDBago.m3u8" />
                  <div className="card-overlay" />
                  <div className="card-content">
                    <span className="pill-badge">JD 对齐率</span>
                    <div>
                      <h3 className="card-2-heading">98.4% 匹配度</h3>
                      <p className="card-meta-desc">精准命中标杆岗位核心要求与技术栈词库。</p>
                    </div>
                  </div>
                </article>

                <article className="card card-3">
                  <HeroVideo className="card-video" source="https://stream.mux.com/6yvj9SR5bjmXq9N3ak7gy427RwUs8R2ZoH4ndA7Q1018.m3u8" />
                  <div className="card-overlay" />
                  <div className="card-content">
                    <span className="pill-badge">约面提升</span>
                    <div>
                      <div className="card-3-number">3.2x</div>
                      <p className="card-meta-desc">经改写并由 A4 精准排版交付后的平均面试邀请倍率。</p>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
