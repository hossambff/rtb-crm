"use client";
import Link from "next/link";
import { memo, type ReactNode } from "react";
import { renderMarkdown, type LinkComponent } from "@/lib/copilot/markdown";

const AppLink: LinkComponent = ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) =>
  href.startsWith("/") ? (
    <Link href={href} className={className}>
      {children}
    </Link>
  ) : (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );

/** Safe markdown (no raw HTML) with in-app links via next/link. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{renderMarkdown(text, { Link: AppLink })}</div>;
});
