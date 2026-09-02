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
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>MUST登校</h1>
        <p style={{ color: "var(--danger)", marginBottom: 12 }}>数据库未就绪</p>
        <p style={{ color: "var(--muted)", fontSize: 14, lineHeight: 1.6 }}>
          请先完成初始化：配置 .env → npm run db:schema → npm run db:seed
          <br />
          详情：{dbError}
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>MUST登校</h1>
      <p style={{ color: "var(--muted)", fontSize: 14, marginBottom: 16 }}>
        选一条方案，开始计时
      </p>

      {active && (
        <button
          onClick={() => router.push(`/timer/${active.id}`)}
          style={{ background: "var(--ok)", marginBottom: 20 }}
        >
          ▶ 继续进行中的计时（{active.summary}）
        </button>
      )}

      {GROUPS.map((g) => {
        const groupPlans = plans.filter((p) => p.to_kind === g.kind);
        if (groupPlans.length === 0) return null;
        return (
          <section key={g.kind} style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 10 }}>{g.title}</h2>
            {groupPlans.map((p) => (
              <button
                key={p.id}
                onClick={() => start(p.id)}
                disabled={starting !== null}
                style={{
                  marginBottom: 8,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "var(--card)",
                  color: "var(--text)",
                }}
              >
                <span style={{ textAlign: "left" }}>{p.summary}</span>
                <span
                  style={{
                    fontSize: 13,
                    color: p.samples >= 5 ? "var(--ok)" : "var(--muted)",
                    flexShrink: 0,
                    marginLeft: 8,
                  }}
                >
                  {p.samples} 份
                </span>
              </button>
            ))}
          </section>
        );
      })}

      <button
        onClick={() => router.push("/records")}
        style={{ background: "var(--card)", color: "var(--muted)", fontSize: 14, marginBottom: 8 }}
      >
        📋 通勤记录（查看 / 删除测试数据）
      </button>

      <p style={{ marginTop: "auto", color: "var(--muted)", fontSize: 12, textAlign: "center" }}>
        数据来源：澳门交通事务局
      </p>
    </main>
  );
}
