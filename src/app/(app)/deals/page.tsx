import { redirect } from "next/navigation";

/** /deals has no index of its own — deals live on the pipeline boards. */
export default function DealsIndex() {
  redirect("/pipelines");
}
