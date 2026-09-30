"use client";
import { SegmentError } from "@/components/analytics/segment-error";

export default function AnalyticsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <SegmentError error={error} retry={retry} what="this dashboard" />;
}
