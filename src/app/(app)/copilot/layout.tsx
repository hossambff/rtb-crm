import { guardModule } from "@/lib/page-guard";

/** QA-09: role check before streaming so a forbidden role gets a real 403 (see src/lib/page-guard.ts). */
export default async function CopilotLayout({ children }: LayoutProps<"/copilot">) {
  await guardModule("copilot", "use_ai");
  return children;
}
