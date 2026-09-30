import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getPipelineOptions, getProducts } from "@/lib/admin/config-queries";
import { ProductsEditor } from "@/components/admin/products-editor";

export const metadata = { title: "Products" };

export default async function ProductsAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden(); // NEW-1: real 403
  const [products, pipelines] = await Promise.all([getProducts(), getPipelineOptions()]);
  return <ProductsEditor products={products} pipelines={pipelines.map((p) => ({ key: p.key, name: p.name, color: p.color }))} />;
}
