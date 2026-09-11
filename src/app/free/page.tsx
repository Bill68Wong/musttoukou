import FreeRideClient from "@/components/FreeRideClient";

export const dynamic = "force-dynamic";

/** /free —— 自由记站（独立数据采集：实测任意两站间行车时长） */
export default async function FreePage({
  searchParams,
}: {
  searchParams: Promise<{ ride?: string }>;
}) {
  const sp = await searchParams;
  const restoreRideId = sp.ride ? Number(sp.ride) : null;
  return <FreeRideClient restoreRideId={Number.isFinite(restoreRideId) ? restoreRideId : null} />;
}
