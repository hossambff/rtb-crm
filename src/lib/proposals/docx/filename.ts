/** Safe download filenames (pure, unit tested): ASCII only, no path separators, quotes or control characters. */
export function safeFilename(base: string, ext = "docx", max = 120): string {
  const cleaned = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics after decomposition
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, max)
    .replace(/[-.]+$/g, "");
  const name = cleaned || "document";
  const e = ext.replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  return e ? `${name}.${e}` : name;
}

/** Content-Disposition header value for an attachment with an already-safe ASCII filename. */
export function attachmentDisposition(filename: string): string {
  const safe = safeFilename(filename.replace(/\.[A-Za-z0-9]{1,10}$/, ""), (/\.([A-Za-z0-9]{1,10})$/.exec(filename)?.[1] ?? ""));
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
