import { FaultsView } from "@/app/_components/views/FaultsView";

/** /arizalar ve /arizalar?bolge=<slug> (bölge detayından gelince süzülü açılır). */
export default async function FaultsPage({
  searchParams,
}: {
  searchParams: Promise<{ bolge?: string | string[] }>;
}) {
  const { bolge } = await searchParams;
  return <FaultsView initialZone={typeof bolge === "string" ? bolge : ""} />;
}
