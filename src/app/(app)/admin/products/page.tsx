import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getPipelineOptions, getProducts } from "@/lib/admin/config-queries";
import { NoAccess } from "@/components/admin/admin-nav";
import { ProductsEditor } from "@/components/admin/products-editor";

export const metadata = { title: "Products" };

export default async function ProductsAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) return <NoAccess />;
  const [products, pipelines] = await Promise.all([getProducts(), getPipelineOptions()]);
  return <ProductsEditor products={products} pipelines={pipelines.map((p) => ({ key: p.key, name: p.name, color: p.color }))} />;
}
