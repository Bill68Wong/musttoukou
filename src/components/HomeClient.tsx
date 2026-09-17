"use client";

/**
 * 首页（v1.0.0：方向卡直达自动选线结果）
 *
 * v0.13.x → v1.0.0 的入口变更：点方向卡不再进「路线选择页」，而是直接进
 * `/recommend`，由服务端在 2 秒内算出**最快 5 条门到门路线**，首页卡片即最终产物。
 *   · 选方向 → 看最快路线（默认路径）
 *   · 开发者模式开启时，`/recommend` 页底出现「查看全部路線」→ 旧 `/routes`（保留未删、带门禁）
 *
 * 座区在这里选（`<ZonePicker/>`，全站唯一入口）：下车后走到 B/C、N/O、R 哪一座，
 * 步行时间差得远，所以它是**必要输入**，随方向卡一起带进 `/recommend`。
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import DevModeToggle from "./DevModeToggle";
import ZonePicker, { useZone } from "./ZonePicker";
import { HOME_SLUG, PAIR_ORDER, PLACE_SHORT, dirLabel, type PlanRow, type ActiveSession } from "@/lib/home-plans-shared";

export default function HomeClient({
  plans,
  active,
  dbError,
  authed,
}: {
  plans: PlanRow[];
  active: ActiveSession | null;
  dbError: string | null;
  /** ★ v1.1.10：是否已过口令门 —— 开发者入口只对已登录者渲染（公众看到的是纯推荐功能） */
  authed: boolean;
}) {
  const router = useRouter();
  const [zone, setZone] = useZone();

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

  // 方向对行：擎天匯 ⇄ school / hengqin / gate（按 PAIR_ORDER；无任何方案的 place 不显示）
  const rows = PAIR_ORDER.map((other) => ({
    other,
    out: plans.filter((p) => p.from_slug === HOME_SLUG && p.to_slug === other),
    back: plans.filter((p) => p.from_slug === other && p.to_slug === HOME_SLUG),
  })).filter((r) => r.out.length > 0 || r.back.length > 0);

  const dirCard = (from: string, to: string, count: number, delayMs: number) => (
    <button
      className="press-card anim-fade-up"
      // v1.0.0：直达自动选线（座区随行；服务端只在涉及澳科大的方向使用它）
      onClick={() => router.push(`/recommend?from=${from}&to=${to}&zone=${encodeURIComponent(zone)}`)}
      style={{ minHeight: 82, animationDelay: `${delayMs}ms` }}
      aria-label={`${dirLabel(from, to)}，${count} 条路线，查看最快路线`}
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
        <span className="t-label t-muted">看最快路線 →</span>
      </span>
    </button>
  );

  return (
    <main className="page">
      <header style={{ marginBottom: 16, padding: "4px 2px" }}>
        <h1 className="h-headline">MUST登校</h1>
        <p className="t-label t-muted" style={{ marginTop: 2 }}>
          選方向 → 立刻看到最快路線
        </p>
      </header>

      {active && (
        <button
          className="press-card press-card--ok anim-pop"
          onClick={() => router.push(`/timer/${active.id}`)}
          style={{ marginBottom: 16, minHeight: 68 }}
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

      {/* 座区：全站唯一选择入口（影响涉及澳科大的方向） */}
      <div style={{ marginTop: 22 }}>
        <ZonePicker value={zone} onChange={setZone} />
      </div>

      {/* ★ v1.1.10：以下入口全部指向**口令保护区**（記錄/統計/自由記站）。
          网站要公开给别人用，而这些是「只有我能看」的数据页 → 只对已登录者显示，
          公众看到的是干净的推荐入口，不会点进一口令墙。 */}
      {authed && (
        <>
          <div style={{ display: "flex", gap: 8, marginTop: 22 }}>
            <button
              className="btn btn--outline btn--sm"
              onClick={() => router.push("/records")}
              style={{ flex: 1, minHeight: 44, fontWeight: 500 }}
            >
              📋 通勤記錄
            </button>
            <button
              className="btn btn--outline btn--sm"
              onClick={() => router.push("/stats")}
              style={{ flex: 1, minHeight: 44, fontWeight: 500 }}
            >
              📊 通勤統計
            </button>
          </div>
          <button
            className="btn btn--outline btn--sm"
            onClick={() => router.push("/free")}
            style={{ width: "100%", minHeight: 44, fontWeight: 500, marginTop: 8 }}
          >
            ⏱ 自由記站（實測站間時長）
          </button>
        </>
      )}

      <div
        className="t-label t-muted"
        style={{
          marginTop: "auto",
          paddingTop: 20,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          opacity: 0.9,
        }}
      >
        {/* ★ v1.1.10：开发者模式开关只对已登录者显示（「开发者模式只有我能开」） */}
        {authed && <DevModeToggle />}
        <p style={{ margin: 0 }}>
          数据来源：澳门交通事务局 ·{" "}
          {/* ★ v1.1.7：纯文字链接原热区仅 ~20px 高，走路时基本点不中 → .link-hit 撑到 44px */}
          <Link href="/about" className="link-hit" style={{ color: "var(--primary)" }}>
            關於本專案
          </Link>
        </p>
      </div>
    </main>
  );
}
