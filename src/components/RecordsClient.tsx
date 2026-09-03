"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface RecordRow {
  id: number;
  started_at: string;
  ended_at: string | null;
  total_minutes: number | null;
  missed_count: number;
  crowd_level: number | null;
  route_code: string | null;
  travel_date: string;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const CROWD_LABELS = ["空", "正常", "挤", "爆满"];

// 固定模板格式化（MM/DD HH:mm），避免 toLocaleString 在 iOS/安卓输出
// 「2026年9月3日 上午12:35」等长格式把行挤爆/截断
function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const macau = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(macau.getUTCMonth() + 1)}/${p(macau.getUTCDate())} ${p(macau.getUTCHours())}:${p(macau.getUTCMinutes())}`;
}

export default function RecordsClient({
  records: initial,
  dbError,
}: {
  records: RecordRow[];
  dbError: string | null;
}) {
  const router = useRouter();
  const [records, setRecords] = useState(initial);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: number) {
    if (!window.confirm("确定删除这条记录？（用于清除测试数据，删除后不参与统计）")) return;
    setDeleting(id);
    setError(null);
    try {
      const res = await fetch(`/api/timer/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "删除失败");
      }
      setRecords((rs) => rs.filter((r) => r.id !== id));
      router.refresh(); // 同步首页样本数
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <main className="page">
      <header style={{ marginBottom: 16, width: "100%" }}>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>通勤记录</h1>
        <p style={{ fontSize: 14, color: "var(--muted)" }}>
          共 {records.length} 条 · 点「删除」清掉测试数据，删除后不计入统计
        </p>
      </header>

      {dbError && (
        <p style={{ color: "var(--danger)", marginBottom: 12 }}>数据库错误：{dbError}</p>
      )}
      {error && <p style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</p>}

      {records.length === 0 && !dbError && (
        <p style={{ color: "var(--muted)", margin: "auto 0" }}>还没有记录</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
        {records.map((r) => (
          <div
            key={r.id}
            style={{
              background: "var(--card)",
              borderRadius: 12,
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}>
              <p style={{ fontSize: 15, lineHeight: 1.5 }}>
                {fmtDateTime(r.started_at)}
                {r.route_code && (
                  <span style={{ color: "var(--muted)", fontSize: 13 }}> · {r.route_code} 路</span>
                )}
              </p>
              <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 2, lineHeight: 1.5 }}>
                {r.ended_at ? (
                  <>
                    {r.total_minutes !== null ? `${r.total_minutes} 分钟` : "已结束"}
                    {r.missed_count > 0 && (
                      <span style={{ color: "var(--danger)" }}> · 没挤上 ×{r.missed_count}</span>
                    )}
                    {r.crowd_level !== null && ` · ${CROWD_LABELS[r.crowd_level] ?? "?"}`}
                  </>
                ) : (
                  <span style={{ color: "var(--accent)" }}>进行中…</span>
                )}
              </p>
            </div>
            <button
              onClick={() => remove(r.id)}
              disabled={deleting === r.id}
              style={{
                background: "transparent",
                color: "var(--danger)",
                border: "1px solid var(--danger)",
                borderRadius: 10,
                padding: 0,
                fontSize: 13,
                minWidth: 56,
                width: 56,
                minHeight: 44,
                height: 44,
                flexShrink: 0,
                alignSelf: "center",
              }}
            >
              {deleting === r.id ? "…" : "删除"}
            </button>
          </div>
        ))}
      </div>

      <button
        onClick={() => router.push("/")}
        style={{ marginTop: 20, background: "var(--card)", color: "var(--muted)" }}
      >
        回首页
      </button>
    </main>
  );
}
