import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getClaims, getProducts } from "@/lib/admin/config-queries";
import { ClaimsEditor } from "@/components/admin/claims-editor";

export const metadata = { title: "Claims library" };

export default async function ClaimsAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden(); // NEW-1: real 403
  const [claims, products] = await Promise.all([getClaims(), getProducts()]);
  return <ClaimsEditor claims={claims} products={products.map((p) => ({ id: p.id, name: p.name, family: p.family }))} />;
}
