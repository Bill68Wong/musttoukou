import FinishForm from "@/components/FinishForm";

export const dynamic = "force-dynamic";

export default async function FinishPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FinishForm sessionId={Number(id)} />;
}
