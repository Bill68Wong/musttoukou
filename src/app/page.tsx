import HomeClient from "@/components/HomeClient";
import { isAuthed } from "@/lib/auth-server";
import { queryActiveSession, queryPlans } from "@/lib/home-plans";

export const dynamic = "force-dynamic";

export default async function Home() {
  let plans: Awaited<ReturnType<typeof queryPlans>> = [];
  let active: Awaited<ReturnType<typeof queryActiveSession>> = null;
  let dbError: string | null = null;

  try {
    [plans, active] = await Promise.all([queryPlans(), queryActiveSession()]);
  } catch (err) {
    dbError = (err as Error).message;
  }

  // ★ v1.1.10：开发者入口（數據頁按钮 / 開發者模式开关）只对已过口令门的人渲染
  const authed = await isAuthed();

  return <HomeClient plans={plans} active={active} dbError={dbError} authed={authed} />;
}
