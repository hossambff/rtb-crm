/**
 * .docx package handling (OOXML zip) with hard safety limits. No DB, no Next — usable from tests.
 *
 * Zip safety: the archive is ≤ 2 MB on upload; entry count, names and declared sizes are checked; only the parts we
 * need ([Content_Types].xml, word/document.xml, headers, footers, foot/endnotes, and *.rels on upload) are ever decompressed, through a
 * byte-counting stream that aborts past a cap (declared sizes can lie). Everything else (images, styles, settings)
 * is passed through compressed and untouched when we write the output.
 */
import JSZip from "jszip";
import type { Readable } from "node:stream";
import { parseXml } from "./xml";
import { substitutePart, type Rule } from "./substitute";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const DOCX_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxEntries: 1000,
  /** Per XML part we decompress. */
  maxPartBytes: 8 * 1024 * 1024,
  /** All XML parts we decompress, together. */
  maxTotalReadBytes: 24 * 1024 * 1024,
  /** Sum of declared uncompressed sizes of every entry (cheap zip-bomb pre-check). */
  maxDeclaredBytes: 128 * 1024 * 1024,
};

export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxError";
  }
}

/** Text-bearing parts: body, headers, footers, footnotes and endnotes (code review L12). */
const TEXT_PART_RE = /^word\/(document|header\d{0,3}|footer\d{0,3}|footnotes|endnotes)\.xml$/;

function declaredSize(f: JSZip.JSZipObject): number {
  const d = (f as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof d?.uncompressedSize === "number" ? d.uncompressedSize : 0;
}

/** Open and validate a .docx archive. Throws DocxError with a user-facing message. */
export async function openDocx(data: Uint8Array, opts: { maxFileBytes?: number } = {}): Promise<JSZip> {
  const max = opts.maxFileBytes ?? DOCX_LIMITS.maxFileBytes;
  if (data.byteLength === 0) throw new DocxError("The file is empty.");
  if (data.byteLength > max) throw new DocxError(`The file is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  if (!(data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04)) throw new DocxError("This is not a .docx file (not a zip archive).");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: false, createFolders: false });
  } catch {
    throw new DocxError("The .docx archive is corrupt or encrypted.");
  }
  const entries = Object.values(zip.files);
  if (entries.length > DOCX_LIMITS.maxEntries) throw new DocxError("The archive has too many entries.");
  let declared = 0;
  for (const f of entries) {
    const name = f.name;
    if (name.length > 260 || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || /[\u0000-\u001f]/.test(name))
      throw new DocxError("The archive contains an invalid entry name.");
    declared += declaredSize(f);
  }
  if (declared > DOCX_LIMITS.maxDeclaredBytes) throw new DocxError("The archive expands to an unreasonable size.");
  if (!zip.file("[Content_Types].xml") || !zip.file("word/document.xml")) throw new DocxError("This is not a Word document (word/document.xml is missing).");
  if (zip.file("word/vbaProject.bin")) throw new DocxError("Macro-enabled documents are not accepted.");
  const types = await readEntryText(zip, "[Content_Types].xml", 512 * 1024);
  if (!/wordprocessingml\.document\.main\+xml/.test(types) || /macroEnabled/i.test(types)) throw new DocxError("This is not a standard .docx Word document.");
  return zip;
}

/** Decompress one entry as UTF-8 text, aborting once more than `cap` bytes come out. */
export async function readEntryText(zip: JSZip, name: string, cap: number = DOCX_LIMITS.maxPartBytes): Promise<string> {
  const f = zip.file(name);
  if (!f) throw new DocxError(`Missing part ${name}.`);
  if (declaredSize(f) > cap) throw new DocxError(`Part ${name} is too large.`);
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let done = false;
    const stream = f.nodeStream("nodebuffer") as unknown as Readable;
    stream.on("data", (chunk: Buffer) => {
      if (done) return;
      n += chunk.length;
      if (n > cap) {
        done = true;
        stream.destroy();
        reject(new DocxError(`Part ${name} is too large.`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stream.on("error", () => {
      if (done) return;
      done = true;
      reject(new DocxError(`Part ${name} could not be read.`));
    });
  });
}

/** The text-bearing parts: document first, then headers and footers. */
export function textPartNames(zip: JSZip): string[] {
  const names = Object.keys(zip.files).filter((n) => TEXT_PART_RE.test(n));
  return names.sort((a, b) => (a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b)));
}

/** Read and well-formedness-check every text part (bounded in total). */
export async function readTextParts(zip: JSZip): Promise<{ name: string; xml: string }[]> {
  const out: { name: string; xml: string }[] = [];
  let total = 0;
  for (const name of textPartNames(zip)) {
    const xml = await readEntryText(zip, name);
    total += xml.length;
    if (total > DOCX_LIMITS.maxTotalReadBytes) throw new DocxError("The document text is too large.");
    try {
      parseXml(xml);
    } catch (e) {
      throw new DocxError(`${name} is not well-formed XML (${e instanceof Error ? e.message.slice(0, 80) : "parse error"}).`);
    }
    out.push({ name, xml });
  }
  return out;
}

/**
 * Produce a filled .docx: substitute rules in the text parts (formatting preserved), pass everything else through,
 * then re-open the output and re-parse every text part. Never returns an archive that fails that check.
 */
export async function generateDocx(template: Uint8Array, rules: Rule[]): Promise<{ buffer: Buffer; replaced: number; keys: Record<string, number> }> {
  const zip = await openDocx(template);
  let replaced = 0;
  const keys: Record<string, number> = {};
  for (const { name, xml } of await readTextParts(zip)) {
    const res = substitutePart(xml, name, rules);
    if (!res.replaced) continue;
    replaced += res.replaced;
    for (const [k, v] of Object.entries(res.keys)) keys[k] = (keys[k] ?? 0) + v;
    zip.file(name, res.xml, { compression: "DEFLATE" });
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  // Validate the output: a real zip, still a Word document, every text part well-formed.
  const check = await openDocx(buffer, { maxFileBytes: DOCX_LIMITS.maxFileBytes * 4 });
  await readTextParts(check);
  return { buffer, replaced, keys };
}

/** Relationship types that may legitimately point outside the package (a clickable link). */
const SAFE_EXTERNAL_REL = /\/relationships\/hyperlink$/;
/** Parts that embed active or foreign content. */
const EMBEDDED_PART_RE = /^word\/(embeddings|activeX)\//i;
const RISKY_REL_TYPE = /\/relationships\/(aFChunk|oleObject|package|control|subDocument|attachedTemplate|frame)$/i;

/**
 * Reasons a package must not become a template (SEC L-6): generated term sheets go to partners, so a template may
 * not carry remote templates / images (TargetMode="External" other than hyperlinks — those leak the opener's IP or
 * NTLM hash), embedded OLE objects, ActiveX controls, alt-chunks or sub-documents. Pure over `.rels` texts + names.
 */
export function packageRisks(partNames: string[], rels: { name: string; xml: string }[]): string[] {
  const out = new Set<string>();
  if (partNames.some((n) => EMBEDDED_PART_RE.test(n))) out.add("embedded objects or ActiveX controls");
  for (const { xml } of rels) {
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      const type = /\bType="([^"]*)"/.exec(tag)?.[1] ?? "";
      const external = /\bTargetMode="External"/i.test(tag);
      if (RISKY_REL_TYPE.test(type)) out.add("embedded or linked documents (OLE, alt-chunk, sub-document or remote template)");
      else if (external && !SAFE_EXTERNAL_REL.test(type)) out.add("links to outside files (e.g. remote images or templates)");
    }
  }
  return [...out];
}

/** Throw when the package carries external or embedded content (checked on upload). */
export async function assertSafePackage(zip: JSZip): Promise<void> {
  const names = Object.keys(zip.files);
  const relNames = names.filter((n) => /\.rels$/i.test(n)).slice(0, 200);
  const rels: { name: string; xml: string }[] = [];
  for (const name of relNames) rels.push({ name, xml: await readEntryText(zip, name, 512 * 1024) });
  const risks = packageRisks(names, rels);
  if (risks.length) throw new DocxError(`This document contains ${risks.join(" and ")}. Remove them in Word (or save a clean copy) and upload again.`);
}
