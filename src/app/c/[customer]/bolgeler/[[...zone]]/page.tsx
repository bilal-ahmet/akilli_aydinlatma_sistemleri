import { notFound } from "next/navigation";
import { ZonesView } from "@/app/_components/views/ZonesView";

/** /bolgeler (ilk bölge) ve /bolgeler/<slug> (seçili bölge). */
export default async function ZonesPage({
  params,
}: {
  params: Promise<{ zone?: string[] }>;
}) {
  const { zone } = await params;
  if (zone && zone.length > 1) notFound();
  return <ZonesView zoneSlug={zone?.[0] ?? null} />;
}
