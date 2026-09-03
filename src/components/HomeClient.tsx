"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface PlanRow {
  id: number;
  summary: string;
  to_kind: string;
  samples: number;
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
      const { sessionId } = (await res.json()) as { sessionId: number };
      router.push(`/timer/${sessionId}`);
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

      {GROUPS.map((g, gi) => {
        const groupPlans = plans.filter((p) => p.to_kind === g.kind);
        if (groupPlans.length === 0) return null;
        return (
          <section key={g.kind} style={{ marginBottom: gi === GROUPS.length - 1 ? 28 : 24 }}>
            <h2 className="group-title">{g.title}</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {groupPlans.map((p, pi) => (
                <button
                  key={p.id}
                  className="press-card anim-fade-up"
                  onClick={() => start(p.id)}
                  disabled={starting !== null}
                  style={{ animationDelay: `${pi * 30}ms` }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>{p.summary}</span>
                  <span
                    className={p.samples >= 5 ? "t-ok" : "t-muted"}
                    style={{ fontSize: 13, flexShrink: 0, fontWeight: 600 }}
                  >
                    {p.samples} 份
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}

      <button
        className="btn btn--outline btn--block btn--sm"
        onClick={() => router.push("/records")}
        style={{ minHeight: 44, fontWeight: 500 }}
      >
        📋 通勤记录（查看 / 删除测试数据）
      </button>

      <p
        className="t-label t-muted t-center"
        style={{ marginTop: "auto", paddingTop: 20, opacity: 0.8 }}
      >
        数据来源：澳门交通事务局
      </p>
    </main>
  );
}
