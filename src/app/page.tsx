import { BrandMark } from "@/components/brand-mark";

export default function Home() {
  return (
    <main className="landing" aria-labelledby="page-title" data-testid="sign-in-page">
      <div className="landing__content">
        <div className="wordmark" aria-label="MindTree">
          <BrandMark />
          <span>MindTree</span>
        </div>

        <p className="eyebrow">Hierarchical thinking</p>
        <h1 id="page-title">See how your thoughts grow.</h1>
        <p>
          Organize your ideas your way, then develop and synthesize them at any level.
        </p>
        <div className="auth-action">
          <a className="button button--primary" href="https://github.com/ECWireless/mindtree">
            View source
          </a>
        </div>
      </div>
    </main>
  );
}
