/**
 * Synthetic .docx builder for tests. Everything here is invented sample text and numbers — it is NOT the wording or
 * the schedule of any real template (those live only in the admin-uploaded file).
 */
import JSZip from "jszip";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

export const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

export const run = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
export const tab = (rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:tab/></w:r>`;
export const para = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
export const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(run(text))}</w:tc>`;
export const table = (rows: string[][]) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows.map((r) => `<w:tr>${r.map(cell).join("")}</w:tr>`).join("")}</w:tbl>`;

export function documentXml(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;
}

export function headerXml(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${W}>${body}</w:hdr>`;
}

/** A small invented "partner letter": split tokens, a date, blanks, tab-blanks and a tier table. */
export const SAMPLE_BODY = [
  para(run("Sample Partner Letter"), '<w:pStyle w:val="Title"/>'),
  para(run("March 3rd, 2031")),
  // "[Recipient Name]" split across three runs with different formatting
  para(run("Dear ") + run("[Recip", "<w:b/>") + run("ient Na", "<w:i/>") + run("me],")),
  para(run("We invite [Company] &amp; its brands to the sample network in [Market].")),
  para(run("Audience schedule:")),
  table([
    ["Monthly users", "Partner share", "Network share"],
    ["&gt;90M", "61%", "39%"],
    ["20M – 90M", "57%", "43%"],
    ["&lt;20M", "52%", "48%"],
  ]),
  para(run("Effective as of May 9, 2031 between the parties.")),
  para(run("Name: ") + run("______________", '<w:u w:val="single"/>')),
  para(run("Title:") + tab('<w:u w:val="single"/>') + tab('<w:u w:val="single"/>')),
  para(run("By: ________________")),
].join("");

export async function buildDocx(opts: { body?: string; header?: string; extra?: Record<string, string>; contentTypes?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", opts.contentTypes ?? CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", documentXml(opts.body ?? SAMPLE_BODY));
  zip.file("word/header1.xml", headerXml(opts.header ?? para(run("Confidential sample · [Company]"))));
  for (const [k, v] of Object.entries(opts.extra ?? {})) zip.file(k, v);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
