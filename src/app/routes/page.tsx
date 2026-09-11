import Link from "next/link";
import RoutePlanList from "@/components/RoutePlanList";
import { dirLabel, queryPlans, queryRouteColors, type PlanRow } from "@/lib/home-plans";

export const dynamic = "force-dynamic";

/**
 * 路线选择页（v0.13.x 新增）
 * 首页点方向卡进入：/routes?from=home&to=school —— 列出该方向下的所有乘车方案，
 * 点击任一方案直接启动计时。
 */
export default async function RoutesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const from = typeof sp.from === "string" ? sp.from : "";
  const to = typeof sp.to === "string" ? sp.to : "";
  const valid = Boolean(from && to);

  let plans: PlanRow[] = [];
  let dbError: string | null = null;
  // v0.20.0：全量线路色表（供卡片上的线路标签取主题色）
  let routeColors: Record<string, string> = {};
  if (valid) {
    try {
      plans = await queryPlans({ from, to });
      routeColors = await queryRouteColors();
    } catch (err) {
      dbError = (err as Error).message;
    }
  }

  return (
    <main className="page">
      <header style={{ marginBottom: 18, width: "100%", padding: "0 2px" }}>
        <Link
          href="/"
          className="btn btn--text btn--sm"
          style={{ marginLeft: -8, minHeight: 36, padding: "0 10px", fontWeight: 500 }}
        >
          ‹ 首页
        </Link>
        {/* v0.20.9（主人）：页头写「出发地 → 目的地」（如 擎天匯 → 橫琴口岸）；
            卡片右侧的地点名与「路线 N 份」已删除，避免重复 */}
        <h1 className="h-headline" style={{ marginTop: 6 }}>
          {valid ? dirLabel(from, to) : "选择路线"}
        </h1>
        <p className="t-label t-muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
          {dbError
            ? `数据库未就绪：${dbError}`
            : valid
              ? `共 ${plans.length} 条路线 · 点选一条开始计时`
              : "请从首页选择方向进入"}
        </p>
      </header>

      {!dbError && valid && <RoutePlanList plans={plans} routeColors={routeColors} />}
    </main>
  );
}
