/**
 * A Word document (`.docx`) holding Markdown, so the seed uploads files
 * as people do: a paragraph per block, a heading (`# …`) in Word's own
 * heading style, and every other block's lines kept as line breaks, so
 * a list or a table reads back as it was written.
 */
import { strToU8, zipSync } from "fflate";

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const packageRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const documentRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const wordNs = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Word's built-in heading styles, by level. */
const headingLevels = [1, 2, 3] as const;

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${wordNs}">${headingLevels
  .map(
    (level) =>
      `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr></w:style>`
  )
  .join("")}</w:styles>`;

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const heading = /^(?<marks>#{1,3}) (?<title>.+)$/u;

/** A blank line, which ends a Markdown block. */
const blankLine = /\n\s*\n/u;

/** One block of Markdown as a Word paragraph. */
const paragraphOf = (block: string): string => {
  const found = heading.exec(block)?.groups;
  if (found?.marks !== undefined && found.title !== undefined) {
    return `<w:p><w:pPr><w:pStyle w:val="Heading${found.marks.length}"/></w:pPr><w:r><w:t>${escapeXml(found.title)}</w:t></w:r></w:p>`;
  }
  const lines = block
    .split("\n")
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`);
  return `<w:p><w:r>${lines.join("<w:br/>")}</w:r></w:p>`;
};

/**
 * Every file's time in the package: a fixed one, so the same Markdown
 * makes the same bytes on every run of the seed.
 */
const fixedTime = new Date("2026-09-01T09:00:00Z");

/** `markdown` as a Word document's bytes. */
export const wordDocument = (markdown: string): Uint8Array => {
  const blocks = markdown
    .trim()
    .split(blankLine)
    .map((block) => block.trim());
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${wordNs}"><w:body>${blocks.map(paragraphOf).join("")}</w:body></w:document>`;
  return zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(packageRelationships),
      "word/_rels/document.xml.rels": strToU8(documentRelationships),
      "word/document.xml": strToU8(document),
      "word/styles.xml": strToU8(styles),
    },
    { mtime: fixedTime }
  );
};
