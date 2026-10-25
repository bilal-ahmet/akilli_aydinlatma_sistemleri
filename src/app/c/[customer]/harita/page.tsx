import { MapView } from "@/app/_components/views/MapView";

/** /harita, /harita?bolge=<slug> (bölge detayından), /harita?direk=<id> (arıza kartından). */
export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ bolge?: string | string[]; direk?: string | string[] }>;
}) {
  const { bolge, direk } = await searchParams;
  return (
    <MapView
      initialZone={typeof bolge === "string" ? bolge : ""}
      initialPole={typeof direk === "string" ? direk : ""}
    />
  );
}
