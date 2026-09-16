"use client";
/**
 * 开发者操作区（src/components/card/CardDevActions.tsx，v1.1.8）
 *
 * ★ 计时入口**迁移到此处**（用户 2026-09-16）：
 *   原先「点预测卡片」在开发者模式下会直接 `POST /api/timer` 建会话；现在卡片点击**一律进详情页**，
 *   建会话只在这里发生，且**仅开发者模式可见**。
 * ⚠️ `/routes` 页的「点方案卡即建会话」**保留不动**（那是另一个开发者专用页）。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RecommendCard as CardData, SchoolZone } from "@/lib/recommend/types";

export default function CardDevActions({
  card,
  zone,
}: {
  card: CardData;
  /** 澳科大座区（建会话时要随之上报，供步行统计分座） */
  zone: SchoolZone | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const first = card.rides[0];

  async function startTimer() {
    if (busy || !first) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/timer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planId: card.planId,
          route: first.route,
          board: first.board,
          alight: first.alight,
          zone,
        }),
      });
      const body = (await res.json()) as { sessionId?: number; error?: string };
      if (!res.ok || !body.sessionId) throw new Error(body.error ?? "创建会话失败");
      router.push(`/timer/${body.sessionId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "创建会话失败");
      setBusy(false);
    }
  }

  return (
    <div className="rc-actions">
      <button className="btn btn--primary btn--lg btn--block" disabled={busy} onClick={() => void startTimer()}>
        {busy ? "開啟中…" : "開始計時"}
      </button>
      <p className="t-label t-muted t-center" style={{ marginTop: 8 }}>
        開發者模式 · 將以本條路線（{first ? `${first.route} ${first.board} → ${first.alight}` : "—"}）建立計時會話
      </p>
      {err && <p className="t-error t-center" role="alert">{err}</p>}
    </div>
  );
}
