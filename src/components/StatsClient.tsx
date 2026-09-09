"use client";

import { useRouter } from "next/navigation";

export interface PlanStat {
  plan_id: number;
  plan_key: string;
  summary: string;
  from_slug: string;
  to_slug: string;
  /** v0.18.2：实乘线路（同台多线按线路拆分统计）；横琴方案为 null（不拆） */
  route_code: string | null;
  /** v0.18.2：summary 剥掉线路前缀后的起讫描述（卡片副标题用） */
  route_summary: string;
  n: number;
  avg_min: number | null;
  min_min: number | null;
  max_min: number | null;
  last_end: string | null;
}

/** v0.18.2：方向小块（去程 home→X / 回程 X→home） */
export interface DirStat {
  dir: "out" | "back";
  title: string;
  plans: PlanStat[];
}

export interface GroupStat {
  kind: string;
  title: string;
  dirs: DirStat[];
}

/** v0.18.2：线路展示名（轻轨「氹仔線」/ 巴士「26 路」） */
function routeLabel(code: string | null): string {
  if (!code) return "";
  if (code.startsWith("LRT-"))
    return code.replace(/^LRT-/, "").replace(/湾/g, "灣").replace(/横/g, "橫").replace(/线/g, "線");
  return `${code} 路`;
}

export interface Summary {
  n: number;
  days: number;
  avg_min: number | null;
  met: number;
  active: number;
}

const GOAL = 5; // 每方案采集目标（达标后进度条变绿，用于历史兜底估算）

export default function StatsClient({
  groups,
  summary,
  dbError,
  includeTest,
}: {
  groups: GroupStat[];
  summary: Summary | null;
  dbError: string | null;
  includeTest?: boolean;
}) {
  const router = useRouter();
  const width = (n: number) => Math.min(100, Math.round((n / GOAL) * 100));

  // v0.10.0「含测试」偏好：写 cookie 后刷新（服务端按偏好过滤）
  function toggleIncludeTest() {
    document.cookie = `mtk_include_test=${includeTest ? "0" : "1"}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  return (
    <main className="page">
      <header style={{ marginBottom: 16, width: "100%", padding: "0 2px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h1 className="h-headline" style={{ margin: 0 }}>
            通勤统计
          </h1>
          <button
            role="switch"
            aria-checked={!!includeTest}
            className={`chip${includeTest ? " chip--on" : ""}`}
            onClick={toggleIncludeTest}
            style={{ marginLeft: "auto" }}
          >
            🧪 含测试 {includeTest ? "开" : "关"}
          </button>
          <a
            className="btn btn--outline btn--sm"
            style={{ fontWeight: 500 }}
            href="/api/export"
            download
          >
            ⬇ CSV
          </a>
        </div>
        <p className="t-label t-muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
          {summary ? (
            <>
              已完成 {summary.n} 份样本 · 覆盖 {summary.days} 天 · 平均{" "}
              {summary.avg_min ?? "-"} 分钟
              <br />
              达标方案 {summary.met}/{summary.active} · 每方案集满 {GOAL} 份进度条变绿
            </>
          ) : (
            "暂无样本"
          )}
        </p>
      </header>

      {dbError && (
        <p className="t-error t-body" style={{ marginBottom: 12, width: "100%" }}>
          数据库错误：{dbError}
        </p>
      )}

      {groups.map((g, gi) => (
        <section key={g.kind} style={{ marginBottom: gi === groups.length - 1 ? 28 : 24, width: "100%" }}>
          <h2 className="group-title">{g.title}</h2>
          {g.dirs.map((d) => (
            <div key={d.dir} style={{ marginBottom: 14 }}>
              <p className="t-label t-muted" style={{ margin: "0 0 8px 2px", fontWeight: 600 }}>
                {d.title}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {d.plans.map((p) => {
              const done = p.n >= GOAL;
              const has = p.n > 0;
              const label = routeLabel(p.route_code);
              return (
                <article
                  key={`${p.plan_id}:${p.route_code ?? "all"}`}
                  className="card"
                  style={{ padding: "13px 14px" }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}>
                      <p className="t-body" style={{ lineHeight: 1.5 }}>
                        {label ? (
                          <>
                            <strong style={{ fontWeight: 700 }}>{label}</strong>
                            <span className="t-muted"> · {p.route_summary || p.summary}</span>
                          </>
                        ) : (
                          p.summary
                        )}
                      </p>
                      <p className="t-label t-muted" style={{ marginTop: 4, lineHeight: 1.5 }}>
                        {has
                          ? `${p.n} 份 · 均值 ${p.avg_min} · ${p.min_min}–${p.max_min} 分钟`
                          : "暂无样本 · 优先采集"}
                      </p>
                    </div>
                    <span
                      className={done ? "t-ok" : "t-muted"}
                      style={{ fontSize: 12, flexShrink: 0, fontWeight: 700, paddingTop: 2 }}
                    >
                      {done ? "✓ 达标" : `${p.n}/${GOAL}`}
                    </span>
                  </div>

                  {/* 采集进度条：n/GOAL，≥GOAL 变绿 */}
                  <div
                    role="progressbar"
                    aria-valuenow={p.n}
                    aria-valuemin={0}
                    aria-valuemax={GOAL}
                    style={{
                      marginTop: 10,
                      height: 8,
                      borderRadius: 999,
                      background: "var(--surface-dim)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${width(p.n)}%`,
                        height: "100%",
                        borderRadius: 999,
                        background: done ? "var(--ok)" : "var(--primary)",
                        opacity: has ? 1 : 0.45,
                        transition: "width 300ms var(--ease-em, ease)",
                      }}
                    />
                  </div>
                </article>
              );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}

      {!dbError && summary && summary.n === 0 && (
        <p className="t-body t-muted t-center" style={{ margin: "auto 0" }}>
          还没有完成过计时——先去首页走一趟完整通勤吧 🚌
        </p>
      )}

      <p
        className="t-label t-muted t-center"
        style={{ marginTop: "auto", paddingTop: 20, opacity: 0.8 }}
      >
        统计范围：已完成（非删除{includeTest ? "，含测试" : "，不含测试"}）的计时 · 数据来源：澳门交通事务局
      </p>
    </main>
  );
}
