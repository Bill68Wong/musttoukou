import FreeHistoryClient from "@/components/FreeHistoryClient";

export const dynamic = "force-dynamic";

/** /free/history —— 自由记站采集记录（独立页面，v0.23.0：从 /free 底部拆出，含删除） */
export default function FreeHistoryPage() {
  return <FreeHistoryClient />;
}
