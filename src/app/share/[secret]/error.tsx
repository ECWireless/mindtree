"use client";

import { BrandMark } from "@/components/brand-mark";

export default function PublicTrailError() {
  return (
    <main className="public-trail-unavailable" aria-labelledby="public-trail-error-title">
      <div className="wordmark" aria-label="MindTree">
        <BrandMark />
        <span>MindTree</span>
      </div>
      <p className="eyebrow">Shared thought trail</p>
      <h1 id="public-trail-error-title">This thought trail is unavailable.</h1>
      <p>MindTree couldn’t load this shared trail right now. Try again later.</p>
    </main>
  );
}
