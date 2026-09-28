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
    <div className="flex max-w-[1100px] flex-col gap-4">
      <UserManager customerSlug={customer.slug} currentUserId={user.id} canManage />
    </div>
  );
}
