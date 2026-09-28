import Link from "next/link";
import { notFound } from "next/navigation";
import { UserManager } from "@/app/_components/UserManager";
import { requireCustomerAccess } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Müşteri kullanıcıları — müşteri yöneticisi ve admin. İzleyici için 404. */
export default async function CustomerUsersPage({
  params,
}: {
  params: Promise<{ customer: string }>;
}) {
  const { customer: slug } = await params;
  const { user, customer } = await requireCustomerAccess(slug);
  if (user.role === "viewer") notFound();

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/c/${customer.slug}`} className="text-xs font-medium text-accent hover:underline">
        ← Dashboard
      </Link>
      <UserManager customerSlug={customer.slug} currentUserId={user.id} canManage />
    </div>
  );
}
