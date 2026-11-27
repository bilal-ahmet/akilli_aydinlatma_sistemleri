import { notFound } from "next/navigation";
import { MeshView } from "@/app/_components/views/MeshView";
import { requireCustomerAccess } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Ağ haritası (Thread mesh rotaları) — YALNIZCA sistem yöneticisi; müşteri kullanıcılarına 404. */
export default async function MeshPage({ params }: { params: Promise<{ customer: string }> }) {
  const { customer: slug } = await params;
  const { user } = await requireCustomerAccess(slug);
  if (user.role !== "admin") notFound();
  return <MeshView />;
}
