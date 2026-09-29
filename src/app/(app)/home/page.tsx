import { requireUser } from "@/lib/rbac/server";
import { PageHeader } from "@/components/ui/misc";

export const metadata = { title: "My Day" };

export default async function HomePage() {
  const user = await requireUser();
  return <PageHeader title={`Good day, ${user.name.split(" ")[0]}`} description="Your tasks, alerts and meetings for today." />;
}
