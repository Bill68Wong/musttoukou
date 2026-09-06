"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { readTestMode, TEST_MODE_KEY } from "@/components/RoutePlanList";
import { HOME_SLUG, PAIR_ORDER, PLACE_SHORT, dirLabel, type PlanRow, type ActiveSession } from "@/lib/home-plans-shared";

/**
 * 首页（v0.13.x 改版：按方向对分行）
 * 每行一对方向卡：左 = 擎天匯 → 目的地（去程），右 = 目的地 → 擎天匯（回程）；
 * 点方向卡进入 /routes?from=&to= 独立路线选择页，不再把具体方案堆在首页。
 * 测试模式偏好存 localStorage（首页开关 ⇄ 路线选择页 start 共用）。
 */
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
  // v0.10.0 测试模式：开 → 新建会话标 is_test=true（不计入统计/记录/导出）
  const [testMode, setTestMode] = useState(false);

  // 首帧后同步 localStorage 偏好（SSR 首帧恒为 false，避免 hydration 不一致）
  useEffect(() => {
    setTestMode(readTestMode());
  }, []);

  function toggleTestMode() {
    const next = !testMode;
    setTestMode(next);
    try {
      window.localStorage.setItem(TEST_MODE_KEY, next ? "1" : "0");
    } catch {
      /* 隐私模式等场景忽略 */
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

  // 方向对行：擎天匯 ⇄ school / hengqin / guanqin（按 PAIR_ORDER；无任何方案的 place 不显示）
  const rows = PAIR_ORDER.map((other) => ({
    other,
    out: plans.filter((p) => p.from_slug === HOME_SLUG && p.to_slug === other),
    back: plans.filter((p) => p.from_slug === other && p.to_slug === HOME_SLUG),
  })).filter((r) => r.out.length > 0 || r.back.length > 0);

  const dirCard = (from: string, to: string, count: number, delayMs: number) => (
    <button
      className="press-card anim-fade-up"
      onClick={() => router.push(`/routes?from=${from}&to=${to}`)}
      style={{ minHeight: 82, animationDelay: `${delayMs}ms` }}
      aria-label={`${dirLabel(from, to)}，${count} 条路线`}
    >
      <span
        className="pc-inner"
        style={{
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 3,
          justifyContent: "center",
        }}
      >
        <span
          style={{
            fontSize: 15,
            fontWeight: 650,
            letterSpacing: 0.2,
            lineHeight: 1.35,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {PLACE_SHORT[from] ?? from}
          <span aria-hidden style={{ opacity: 0.55, fontSize: 13, flexShrink: 0 }}>
            →
          </span>
          {PLACE_SHORT[to] ?? to}
        </span>
        <span className="t-label t-muted">{count} 条路线</span>
      </span>
    </button>
  );

  return (
    <main className="page">
      <header style={{ marginBottom: 20, padding: "4px 2px" }}>
        <h1 className="h-headline">MUST登校</h1>
        <p className="t-label t-muted" style={{ marginTop: 2 }}>
          选方向 → 选路线 → 开始计时
        </p>
      </header>

      {/* v0.10.0 测试模式开关：测试运行标 is_test，不计入统计/记录（默认关） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 16,
          padding: "10px 14px",
          borderRadius: 16,
          background: "var(--surface-dim, #eef1f4)",
        }}
      >
        <span className="t-label" style={{ fontWeight: 600 }}>
          🧪 测试模式
        </span>
        <button
          role="switch"
          aria-checked={testMode}
          className={`chip${testMode ? " chip--on" : ""}`}
          onClick={toggleTestMode}
          style={{ marginLeft: "auto", minWidth: 76, justifyContent: "center" }}
        >
          {testMode ? "开" : "关"}
        </button>
        <span className="t-label t-muted" style={{ flexShrink: 0 }}>
          {testMode ? "· 测试记录" : "· 真实记录"}
        </span>
      </div>

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

      {/* v0.13.x：方向对分行 —— 左去程（擎天匯→地点）、右回程（地点→擎天匯） */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {rows.map((r) => (
          <section key={r.other}>
            <h2 className="group-title">
              {PLACE_SHORT[HOME_SLUG]} ⇄ {PLACE_SHORT[r.other]}
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {r.out.length > 0
                ? dirCard(HOME_SLUG, r.other, r.out.length, 0)
                : <span className="t-label t-muted" style={{ display: "flex", alignItems: "center" }}>暂无去程方案</span>}
              {r.back.length > 0
                ? dirCard(r.other, HOME_SLUG, r.back.length, 40)
                : <span className="t-label t-muted" style={{ display: "flex", alignItems: "center" }}>暂无回程方案</span>}
            </div>
          </section>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 28 }}>
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
