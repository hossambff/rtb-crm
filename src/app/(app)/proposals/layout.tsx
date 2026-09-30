import { guardModule } from "@/lib/page-guard";

/** QA-09: role check before streaming so a forbidden role gets a real 403 (see src/lib/page-guard.ts). */
export default async function ProposalsLayout({ children }: LayoutProps<"/proposals">) {
  await guardModule("proposals");
  return children;
}
