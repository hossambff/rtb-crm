import { guardModule } from "@/lib/page-guard";

/** QA-09: role check before streaming so a forbidden role gets a real 403 (see src/lib/page-guard.ts). */
export default async function AccountsLayout({ children }: LayoutProps<"/accounts">) {
  await guardModule("accounts");
  return children;
}
