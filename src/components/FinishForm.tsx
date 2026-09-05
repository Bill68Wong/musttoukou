"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface SessionData {
  session: {
    id: number;
    summary: string;
    ended_at: string | null;
    total_minutes: number | null;
    /** v0.13.0：口岸通关耗时（border_start→border_end 闭合区间），独立于行程 */
    border_minutes: number | null;
    missed_count: number;
    crowd_level: number | null;
    vehicle_plate: string | null;
  };
}

const CROWD_OPTIONS = [
  { value: 0, label: "空", desc: "随便坐" },
  { value: 1, label: "正常", desc: "有座或站稳" },
  { value: 2, label: "挤", desc: "贴着站" },
  { value: 3, label: "爆满", desc: "挤不上/前胸贴后背" },
];

export default function FinishForm({ sessionId }: { sessionId: number }) {
  const router = useRouter();
  const [data, setData] = useState<SessionData | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/timer/${sessionId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: SessionData) => setData(d))
      .catch(() => router.push("/"));
  }, [sessionId, router]);

  if (!data) {
    return (
      <main className="page page--center">
        <p className="t-body t-muted t-center">加载中…</p>
      </main>
    );
  }

  const s = data.session;
  // pg NUMERIC 列返回字符串 → 统一转数字；0（不足 30 秒舍入为 0.0）视为未通关不展示
  const borderMin = s.border_minutes != null ? Number(s.border_minutes) : null;
  const hasBorder = borderMin !== null && borderMin > 0;

  async function submit(crowdLevel: number) {
    setSaving(true);
    try {
      await fetch(`/api/timer/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crowd_level: crowdLevel }),
      });
    } finally {
      setSaving(false);
      router.push("/");
    }
  }

  const done = s.crowd_level !== null;

  return (
    <main className="page">
      <header style={{ marginBottom: 20, padding: "0 2px" }}>
        <h1 className="h-display" style={{ marginBottom: 4 }}>
          🎉 到达了
        </h1>
        <p className="t-label t-muted">{s.summary}</p>
      </header>

      <div
        className="card anim-fade-up"
        style={{ padding: 18, marginBottom: 24, textAlign: "center" }}
      >
        <p className="t-label t-muted" style={{ marginBottom: 4 }}>
          总耗时{hasBorder ? "（行程 + 通关）" : ""}
        </p>
        {/* v0.13.0：行程分钟 + 通关分钟（通关不计入行程；有 border 时并列显示并标注） */}
        <p
          className="h-display"
          style={{
            margin: 0,
            fontVariantNumeric: "tabular-nums",
            color: "var(--primary)",
          }}
        >
          {s.total_minutes ?? "—"}
          {hasBorder && (
            <>
              <span style={{ opacity: 0.55 }}>+</span>
              <span style={{ fontSize: "0.82em" }}>{borderMin}</span>
            </>
          )}
          <span
            className="t-body t-muted"
            style={{ marginLeft: 6, fontWeight: 500 }}
          >
            分钟
          </span>
        </p>
        {hasBorder && (
          <p className="t-label t-muted" style={{ marginTop: 6 }}>
            前项为行程时间，后项 {borderMin} 分钟为口岸通关（不计入行程）
          </p>
        )}
        {s.missed_count > 0 && (
          <p className="t-label t-error" style={{ marginTop: 8 }}>
            没挤上 {s.missed_count} 次
          </p>
        )}
        {s.vehicle_plate && (
          <p className="t-label t-muted" style={{ marginTop: 6 }}>
            车辆 {s.vehicle_plate}
          </p>
        )}
      </div>

      {done ? (
        <>
          <p className="t-body t-ok" style={{ marginBottom: 16, textAlign: "center" }}>
            ✓ 已提交（拥挤度：{CROWD_OPTIONS.find((c) => c.value === s.crowd_level)?.label}）
          </p>
          <button className="btn btn--primary btn--block" onClick={() => router.push("/")}>
            回到首页
          </button>
        </>
      ) : (
        <>
          <p className="t-body" style={{ marginBottom: 12 }}>
            这趟车挤吗？
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {CROWD_OPTIONS.map((c) => (
              <button
                key={c.value}
                className="press-card"
                onClick={() => submit(c.value)}
                disabled={saving}
              >
                <span className="h-title">{c.label}</span>
                <span className="t-label t-muted">{c.desc}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
