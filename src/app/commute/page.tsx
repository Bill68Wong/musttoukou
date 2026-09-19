/**
 * 旧首页（原 `/` 的 `HomeClient` 原样迁此）（src/app/commute/page.tsx，v1.3.0 · T04）
 *
 * 产品口径（§2.E）：新首页 `/` 改为全澳导航搜索页后，**旧首页功能完整保留**于 `/commute`
 * —— 方向卡 / 座区选择 / 开发者模式入口，**行为一字不改**。
 * ⚠️ 旧功能的座区仍走 `useZone` 的 localStorage（起点≠座区，不受「起点不记忆」影响）。
 */
import HomeClient from "@/components/HomeClient";
import { isAuthed } from "@/lib/auth-server";
import { queryActiveSession, queryPlans } from "@/lib/home-plans";

export const dynamic = "force-dynamic";

export default async function Commute() {
  let plans: Awaited<ReturnType<typeof queryPlans>> = [];
  let active: Awaited<ReturnType<typeof queryActiveSession>> = null;
  let dbError: string | null = null;

  try {
    [plans, active] = await Promise.all([queryPlans(), queryActiveSession()]);
  } catch (err) {
    dbError = (err as Error).message;
  }

  const authed = await isAuthed();

  return <HomeClient plans={plans} active={active} dbError={dbError} authed={authed} />;
}
