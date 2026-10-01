import { redirect } from "next/navigation";

/** /team/1-1 → the 1:1 prep tab of the team page. */
export default function OneOnOneIndex() {
  redirect("/team?tab=1-1");
}
