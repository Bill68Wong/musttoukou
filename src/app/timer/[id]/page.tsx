import TimerWizard from "@/components/TimerWizard";

export const dynamic = "force-dynamic";

export default async function TimerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TimerWizard sessionId={Number(id)} />;
}
