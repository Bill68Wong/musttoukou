"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import RouteStack from "./RouteStack";

export interface RecordRow {
  id: number;
  started_at: string;
  ended_at: string | null;
  total_minutes: number | null;
  /** v0.13.0：口岸通关耗时（独立于行程，展示「行程 + 通关」） */
  border_minutes?: number | null;
  missed_count: number;
  /** v0.18.0：每程拥挤度（ride_crowd.level 按 veh_index 以「/」连接，如 "1/3"） */
  crowd_levels: string | null;
  route_code: string | null;
  /** v0.20.0：线路标签底色 */
  route_color?: string | null;
  travel_date: string;
  is_test?: boolean;
}

/** v0.18.0：拥挤度五档（0空/1正常/2饱和/3挤/4爆满） */
const CROWD_LABELS = ["空", "正常", "饱和", "挤", "爆满"];
const CROWD_HINTS = ["随便坐", "有座", "没座位但站稳", "贴着站", "前胸贴后背"];

/**
 * v0.18.2：拥挤度展示——旧写法「拥挤 正常」前缀与档名矛盾（会出现「拥挤 空」），
 * 改为「拥挤度：正常」；多程按「/」分隔（如「拥挤度：正常/挤」）
 */
const crowdText = (levels: string | null): string | null => {
  if (!levels) return null;
  const parts = levels
    .split("/")
    .filter((x) => x !== "")
    .map((lv) => CROWD_LABELS[Number(lv)] ?? "?");
  return parts.length ? `拥挤度：${parts.join("/")}` : null;
};
const crowdTitle = (levels: string | null): string =>
  (levels ?? "")
    .split("/")
    .filter((x) => x !== "")
    .map((lv, i) => `第${i + 1}程 ${CROWD_LABELS[Number(lv)] ?? "?"}（${CROWD_HINTS[Number(lv)] ?? "—"}）`)
    .join(" / ");

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
  includeTest,
}: {
  records: RecordRow[];
  dbError: string | null;
  includeTest?: boolean;
}) {
  const router = useRouter();
  const [records, setRecords] = useState(initial);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // v0.10.0「含测试」偏好：写 cookie 后刷新（服务端按偏好过滤）
  function toggleIncludeTest() {
    document.cookie = `mtk_include_test=${includeTest ? "0" : "1"}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

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
      <header style={{ marginBottom: 20, width: "100%", padding: "0 2px" }}>
        <h1 className="h-headline">通勤记录</h1>
        <p className="t-label t-muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
          共 {records.length} 条{includeTest ? "（含测试）" : ""} · 点「删除」清掉测试数据，删除后不计入统计
        </p>
        {/* v0.10.0：测试模式偏好开关（默认排除 is_test=true 的测试运行） */}
        <button
          role="switch"
          aria-checked={!!includeTest}
          className={`chip${includeTest ? " chip--on" : ""}`}
          onClick={toggleIncludeTest}
          style={{ marginTop: 8 }}
        >
          🧪 含测试 {includeTest ? "开" : "关"}
        </button>
      </header>

      {dbError && (
        <p className="t-error t-body" style={{ marginBottom: 12, width: "100%" }}>
          数据库错误：{dbError}
        </p>
      )}
      {error && (
        <p className="t-error t-body" style={{ marginBottom: 12, width: "100%" }}>
          {error}
        </p>
      )}

      {records.length === 0 && !dbError && (
        <p className="t-body t-muted t-center" style={{ margin: "auto 0" }}>
          还没有记录
        </p>
      )}

      <div
        style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}
        className="anim-fade-up"
      >
        {records.map((r) => (
          <article key={r.id} className="card" style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}>
                <p className="t-body" style={{ lineHeight: 1.5 }}>
                  {fmtDateTime(r.started_at)}
                  {r.route_code && (
                    <>
                      {" · "}
                      <RouteStack
                        codes={[r.route_code]}
                        colorOf={() => r.route_color ?? undefined}
                        size="sm"
                      />
                    </>
                  )}
                  {r.is_test && (
                    <span className="t-muted" style={{ fontSize: 12 }}> · 🧪 测试</span>
                  )}
                </p>
                <p
                  className="t-label t-muted"
                  style={{ marginTop: 4, lineHeight: 1.5 }}
                >
                  {r.ended_at ? (
                    <>
                      {/* v0.13.0：含通关的会话显示「行程 xx 分钟 + 通关 xx 分钟」，通关不计入行程
                          （pg NUMERIC 返回字符串 → Number 转换；0 视为无通关） */}
                      {r.total_minutes !== null
                        ? r.border_minutes != null && Number(r.border_minutes) > 0
                          ? `${r.total_minutes} 分钟 + 通关 ${Number(r.border_minutes)} 分钟`
                          : `${r.total_minutes} 分钟`
                        : "已结束"}
                      {r.missed_count > 0 && (
                        <span className="t-error"> · 没挤上 ×{r.missed_count}</span>
                      )}
                      {crowdText(r.crowd_levels) && (
                        <span title={crowdTitle(r.crowd_levels)}>
                          {" · "}
                          {crowdText(r.crowd_levels)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="t-accent">进行中…</span>
                  )}
                </p>
              </div>
              <button
                onClick={() => remove(r.id)}
                disabled={deleting === r.id}
                className="btn btn--danger-outline btn--sm"
                style={{ flexShrink: 0, alignSelf: "center" }}
              >
                {deleting === r.id ? "…" : "删除"}
              </button>
            </div>
          </article>
        ))}
      </div>

      <button
        onClick={() => router.push("/")}
        className="btn btn--outline btn--block"
        style={{ marginTop: 24 }}
      >
        回首页
      </button>
    </main>
  );
}
