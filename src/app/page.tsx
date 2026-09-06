import HomeClient from "@/components/HomeClient";
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

  return <HomeClient plans={plans} active={active} dbError={dbError} />;
}
