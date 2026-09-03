"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface PlanRow {
  id: number;
  summary: string;
  to_kind: string;
  samples: number;
  /** v0.7.0：各载具段主线路主题色（按乘坐顺序，walk 段不参与） */
  colors?: (string | null)[];
}

export interface ActiveSession {
  id: number;
  summary: string;
}

const GROUPS: { kind: string; title: string }[] = [
  { kind: "dorm", title: "回宿舍" },
  { kind: "school", title: "去学校" },
  { kind: "border", title: "去横琴口岸" },
];

/* ---------- v0.7.0 主题色：hex → rgba 淡色，供卡片底色均分渐变 ---------- */
function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(128,128,128,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 卡片底色：1 段=斜向单色淡渐变；多段=按段均分左右色块（换乘几次就几段） */
function veilGradient(colors: (string | null)[]): string {
  const segs = colors.filter((c): c is string => !!c);
  if (segs.length === 0) return "";
  const A = 0.16;
  if (segs.length === 1) {
    return `linear-gradient(135deg, ${hexA(segs[0], A)} 0%, ${hexA(segs[0], A * 0.5)} 100%)`;
  }
  const w = 100 / segs.length;
  const stops = segs
    .map((c, i) => `${hexA(c, A)} ${(i * w).toFixed(2)}% ${((i + 1) * w).toFixed(2)}%`)
    .join(", ");
  return `linear-gradient(to right, ${stops})`;
}

export default function HomeClient({
  plans,
  active,
  dbError,
}: {
  plans: PlanRow[];
  active: ActiveSession | null;
  dbError: string | null;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState<number | null>(null);

  async function start(planId: number) {
    setStarting(planId);
    try {
      const res = await fetch("/api/timer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "启动失败");
      const body = (await res.json()) as { sessionId?: number };
      if (!body.sessionId) throw new Error("启动失败：未返回会话");
      router.push(`/timer/${body.sessionId}`);
    } catch (e) {
      alert((e as Error).message);
      setStarting(null);
    }
  }

  if (dbError) {
    return (
      <main className="page">
        <h1 className="h-headline" style={{ marginBottom: 8 }}>
          MUST登校
        </h1>
        <p className="t-error t-body" style={{ marginBottom: 12 }}>
          数据库未就绪
        </p>
        <p className="t-label t-muted" style={{ lineHeight: 1.6 }}>
          请先完成初始化：配置 .env → npm run db:schema → npm run db:seed
          <br />
          详情：{dbError}
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <header style={{ marginBottom: 20, padding: "4px 2px" }}>
        <h1 className="h-headline">MUST登校</h1>
        <p className="t-label t-muted" style={{ marginTop: 2 }}>
          选一条方案，开始计时
        </p>
      </header>

      {active && (
        <button
          className="press-card press-card--ok anim-pop"
          onClick={() => router.push(`/timer/${active.id}`)}
          style={{ marginBottom: 20, minHeight: 68 }}
        >
          <span className="icon-badge">▶</span>
          <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
            <span className="h-title" style={{ display: "block" }}>
              继续进行中的计时
            </span>
            <span
              className="t-label"
              style={{ display: "block", opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {active.summary}
            </span>
          </span>
          <span aria-hidden style={{ fontSize: 20, opacity: 0.7 }}>
            ›
          </span>
        </button>
      )}

      {starting !== null && (
        <p className="t-body t-accent t-center anim-fade-up" style={{ marginBottom: 12 }}>
          正在启动计时，请稍候…
        </p>
      )}

      {GROUPS.map((g, gi) => {
        const groupPlans = plans.filter((p) => p.to_kind === g.kind);
        if (groupPlans.length === 0) return null;
        return (
          <section key={g.kind} style={{ marginBottom: gi === GROUPS.length - 1 ? 28 : 24 }}>
            <h2 className="group-title">{g.title}</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {groupPlans.map((p, pi) => {
                const isStarting = starting === p.id;
                const veil = p.colors?.some(Boolean) ? veilGradient(p.colors!) : "";
                return (
                  <button
                    key={p.id}
                    className="press-card plan-card anim-fade-up"
                    onClick={() => start(p.id)}
                    disabled={starting !== null}
                    aria-busy={isStarting}
                    style={{ animationDelay: `${pi * 30}ms` }}
                  >
                    {veil && <span aria-hidden className="pc-veil" style={{ background: veil }} />}
                    <span className="pc-inner" style={{ opacity: isStarting ? 0.75 : 1 }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        {isStarting ? "启动中…" : p.summary}
                      </span>
                      <span
                        className={p.samples >= 5 ? "t-ok" : "t-muted"}
                        style={{ fontSize: 13, flexShrink: 0, fontWeight: 600 }}
                      >
                        {isStarting ? "" : `${p.samples} 份`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn btn--outline btn--sm"
          onClick={() => router.push("/records")}
          style={{ flex: 1, minHeight: 44, fontWeight: 500 }}
        >
          📋 通勤记录
        </button>
        <button
          className="btn btn--outline btn--sm"
          onClick={() => router.push("/stats")}
          style={{ flex: 1, minHeight: 44, fontWeight: 500 }}
        >
          📊 通勤统计
        </button>
      </div>

      <p
        className="t-label t-muted t-center"
        style={{ marginTop: "auto", paddingTop: 20, opacity: 0.8 }}
      >
        数据来源：澳门交通事务局
      </p>
    </main>
  );
}
