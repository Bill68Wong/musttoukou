"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface SessionData {
  session: {
    id: number;
    summary: string;
    ended_at: string | null;
    total_minutes: number | null;
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
      <main className="page">
        <p style={{ color: "var(--muted)" }}>加载中…</p>
      </main>
    );
  }

  const s = data.session;

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
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>🎉 到达了</h1>
      <p style={{ color: "var(--muted)", marginBottom: 20 }}>{s.summary}</p>

      <div style={{ background: "var(--card)", borderRadius: 12, padding: 16, marginBottom: 24 }}>
        <p style={{ fontSize: 15 }}>
          总耗时 <strong style={{ fontSize: 26 }}>{s.total_minutes ?? "—"}</strong> 分钟
        </p>
        {s.missed_count > 0 && (
          <p style={{ fontSize: 14, color: "var(--danger)", marginTop: 4 }}>
            没挤上 {s.missed_count} 次
          </p>
        )}
        {s.vehicle_plate && (
          <p style={{ fontSize: 14, color: "var(--muted)", marginTop: 4 }}>
            车辆 {s.vehicle_plate}
          </p>
        )}
      </div>

      {done ? (
        <>
          <p style={{ color: "var(--ok)", marginBottom: 16 }}>
            ✓ 已提交（拥挤度：{CROWD_OPTIONS.find((c) => c.value === s.crowd_level)?.label}）
          </p>
          <button onClick={() => router.push("/")}>回到首页</button>
        </>
      ) : (
        <>
          <p style={{ fontSize: 15, marginBottom: 12 }}>这趟车挤吗？</p>
          {CROWD_OPTIONS.map((c) => (
            <button
              key={c.value}
              onClick={() => submit(c.value)}
              disabled={saving}
              style={{
                marginBottom: 8,
                background: "var(--card)",
                color: "var(--text)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>{c.label}</span>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>{c.desc}</span>
            </button>
          ))}
        </>
      )}
    </main>
  );
}
