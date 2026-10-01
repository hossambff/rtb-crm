import { guardModule } from "@/lib/page-guard";

/** Sequences send from the rep's own mailbox: gated on the `email` module (same as the nav entry). */
export default async function SequencesLayout({ children }: LayoutProps<"/sequences">) {
  await guardModule("email");
  return children;
}
