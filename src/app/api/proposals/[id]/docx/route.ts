import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { DOCX_MIME, generateDocx } from "@/lib/proposals/docx/package";
import { attachmentDisposition, safeFilename } from "@/lib/proposals/docx/filename";
import { buildRules } from "@/lib/proposals/termsheet";
import { getTermSheet } from "@/lib/proposals/term-sheet-queries";
import { loadTemplateFile } from "@/lib/proposals/templates";
import { json, routeError, routeUser } from "@/lib/proposals/http";

/**
 * Download a coalition term sheet version as .docx: the version's template with its frozen mapping and values
 * substituted (formatting preserved), validated before it is sent. Permission = proposal visibility (proposals module
 * + deal access incl. restricted lists); blocked while the version needs approval.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/proposals/[id]/docx">) {
  const user = await routeUser();
  if (user instanceof NextResponse) return user;
  try {
    const { id } = await ctx.params;
    const d = await getTermSheet(user, id);
    if (!d) return json({ error: "Not found." }, 404);
    if (!d.exportable) return json({ error: "This version needs executive approval before it can be exported." }, 409);
    const template = await loadTemplateFile(d.inputs.templateId);
    const { rules, unfilled } = buildRules(d.inputs.snapshot.candidates, d.inputs.snapshot.fieldMap, d.inputs.values);
    const out = await generateDocx(template, rules);
    const who = d.deal.accountName ?? d.deal.name;
    const filename = safeFilename(`Coalition term sheet ${who} v${d.proposal.version}`);
    await audit({
      actorId: user.id,
      action: "proposal.docx_download",
      entity: "proposal",
      entityId: id,
      after: { version: d.proposal.version, templateId: d.inputs.templateId, replaced: out.replaced, unfilled: unfilled.length, bytes: out.buffer.byteLength },
    });
    return new NextResponse(new Uint8Array(out.buffer), {
      headers: {
        "Content-Type": DOCX_MIME,
        "Content-Disposition": attachmentDisposition(filename),
        "Content-Length": String(out.buffer.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return routeError("proposals.docx", e);
  }
}
