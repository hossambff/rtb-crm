import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/guard";
import { DOCX_LIMITS } from "@/lib/proposals/docx/package";
import { createTemplate } from "@/lib/proposals/templates";
import { TEMPLATE_KINDS } from "@/lib/proposals/termsheet";
import { assertSameOrigin, json, routeError, routeUser } from "@/lib/proposals/http";

/**
 * Admin upload of a proposal template (.docx, ≤ 2 MB). Multipart: file, kind, name.
 * Validation (real OOXML zip, bounded decompression, well-formed XML) and analysis happen in createTemplate.
 */
export async function POST(req: Request) {
  const user = await routeUser();
  if (user instanceof NextResponse) return user;
  try {
    await requireAdmin(user);
    assertSameOrigin(req);
    const len = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(len) && len > DOCX_LIMITS.maxFileBytes + 64 * 1024) return json({ error: "The file is larger than 2 MB." }, 413);
    const form = await req.formData();
    const file = form.get("file");
    const kind = String(form.get("kind") ?? "");
    const name = String(form.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!(file instanceof File)) return json({ error: "Attach a .docx file." }, 400);
    if (!TEMPLATE_KINDS.some((k) => k.kind === kind)) return json({ error: "Pick a template kind." }, 400);
    if (!/\.docx$/i.test(file.name)) return json({ error: "Only .docx files are accepted." }, 400);
    if (file.size > DOCX_LIMITS.maxFileBytes) return json({ error: "The file is larger than 2 MB." }, 413);
    const data = new Uint8Array(await file.arrayBuffer());
    const fileName = file.name.replace(/[^\w .()-]+/g, "_").slice(0, 160);
    const res = await createTemplate(user, { kind, name: name || fileName.replace(/\.docx$/i, ""), fileName, data });
    revalidatePath("/admin/templates");
    return json({ id: res.id, version: res.version, active: res.active, candidates: res.candidates, tierTables: res.tierTables });
  } catch (e) {
    return routeError("proposals.template_upload", e);
  }
}
