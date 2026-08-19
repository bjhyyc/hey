"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { loadHomePhotoDraft } from "@/lib/home-photo-draft";
import type { PetSpecies } from "@/lib/photo-slots";

type DraftSummary = { photoCount: number; species: PetSpecies } | null | "loading";

// The controlled path is photos-first: pick photos on the home page, then pay.
// A customer arriving here without a draft is on the direct-buy shortcut, so
// the plan card steers them back to photo selection instead of straight to
// payment — money should follow checkable photos, not precede them.
export function PlanDraftStatus() {
  const [draft, setDraft] = useState<DraftSummary>("loading");

  useEffect(() => {
    loadHomePhotoDraft()
      .then((stored) => {
        const photoCount = stored ? stored.photos.filter(Boolean).length : 0;
        setDraft(photoCount > 0 ? { photoCount, species: stored!.species } : null);
      })
      .catch(() => setDraft(null));
  }, []);

  if (draft === "loading") {
    return <div className="plan-cta"><p className="form-message">正在读取照片…</p></div>;
  }

  if (draft) {
    return (
      <div className="plan-cta">
        <p className="plan-draft-summary">
          已选好 {draft.photoCount} 张照片 · 宠物是{draft.species === "cat" ? "猫" : "狗"}
        </p>
        {/* The way back sits before the way forward, at the same weight of
            type, so changing your mind about the photos is as easy to reach as
            paying for them. */}
        <div className="action-row">
          <Link className="ghost-button" href="/#start">继续调整照片</Link>
          <Link className="primary-button inline-button" href="/projects/new/pay">继续付款</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="plan-cta">
      <div className="workflow-notice plan-draft-notice">
        <p><strong>推荐先挑好照片再付款</strong>：照片质量直接决定成品效果，先选好可以当场检查，付款后立即开始制作。</p>
      </div>
      <Link className="primary-button inline-button" href="/#start">先去选照片</Link>
      <Link className="secondary-link" href="/projects/new/pay">跳过，直接付款</Link>
    </div>
  );
}
