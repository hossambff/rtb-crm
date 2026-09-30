import { StatusBadge } from "@/components/ui/badge";

export const SOURCE_LABELS: Record<string, string> = { granola: "Granola", zoom: "Zoom", meet: "Google Meet", upload: "Upload", paste: "Pasted" };

export function TranscriptStatus({ status }: { status: string }) {
  if (status === "ready") return <StatusBadge status="good" label="Analyzed" />;
  if (status === "failed") return <StatusBadge status="critical" label="Failed" />;
  return <StatusBadge status="warning" label={status === "processing" ? "Analyzing" : "Queued"} />;
}
