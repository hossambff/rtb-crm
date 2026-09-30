import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ForbiddenError, getCurrentUser, type AppUser } from "@/lib/rbac/server";
import { parseUpload, type ImportRequest } from "@/lib/import/server";

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

/** Authenticate a route-handler request (same rules as server actions). */
export async function authed(): Promise<AppUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return json({ error: "You are not signed in." }, 401);
  return user;
}

const formSchema = z.object({
  sheet: z.string().max(200).default(""),
  headerRow: z.coerce.number().int().min(0).max(50).default(0),
  target: z.enum(["accounts_deals", "contacts", "r100", "ads"]),
  pipelineKey: z
    .string()
    .max(20)
    .optional()
    .transform((v) => v || null),
  mapping: z.string().max(100_000),
});

/** Parse the multipart body shared by /preview and /commit: file + sheet + header row + target + mapping JSON. */
export async function readImportForm(req: Request): Promise<ImportRequest> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new Error("Attach a file.");
  const parsed = formSchema.safeParse(Object.fromEntries([...form.entries()].filter(([k]) => k !== "file")));
  if (!parsed.success) throw new Error("Invalid import settings.");
  let mapping: Record<string, string>;
  try {
    mapping = z.record(z.string(), z.string()).parse(JSON.parse(parsed.data.mapping));
  } catch {
    throw new Error("Invalid column mapping.");
  }
  if (!Object.values(mapping).some(Boolean)) throw new Error("Map at least one column.");
  const sheets = await parseUpload(file);
  const sheet = sheets.find((x) => x.name === parsed.data.sheet) ?? sheets[0];
  if (!sheet) throw new Error("The file has no data.");
  return { sheet, headerRow: parsed.data.headerRow, target: parsed.data.target, pipelineKey: parsed.data.pipelineKey, mapping, fileName: file.name.slice(0, 200) };
}

export function errorResponse(e: unknown) {
  if (e instanceof ForbiddenError) return json({ error: e.message }, 403);
  // plain Errors are our own validation messages; library errors (DB, parser) are subclasses and never echoed
  if (e instanceof Error && e.constructor === Error && e.message.length < 300) return json({ error: e.message }, 400);
  console.error("[import] unexpected error", e);
  return json({ error: "Something went wrong. Please try again." }, 500);
}
