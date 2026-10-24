import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ZipAttributes } from "fflate";

// The smallest Word document (.docx, Office Open XML) Word opens: the text
// as plain paragraphs, and, when the call carries one, its effect key as a
// custom document property, `GraspEffect`. Word keeps custom properties
// when a person edits and saves the file, so a call of unknown outcome can
// find its document by the key, as mail finds a draft by its tag.

/** The custom document property a draft carries its effect key in. */
export const effectPropertyName = "GraspEffect";

/** Every entry's time, so the same input always makes the same bytes. */
const zipTime = new Date("1980-01-01T00:00:00Z");

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Text as XML takes it: no markup of its own, and no character XML 1.0 refuses. */
const escaped = (text: string): string =>
  text
    // oxlint-disable-next-line no-control-regex -- XML 1.0 refuses these
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const lineBreak = /\r\n|\r|\n/u;

/** One paragraph per line, its spaces kept as they are. */
const paragraphs = (text: string): string =>
  text
    .split(lineBreak)
    .map((line) =>
      line === ""
        ? "<w:p/>"
        : `<w:p><w:r><w:t xml:space="preserve">${escaped(line)}</w:t></w:r></w:p>`
    )
    .join("");

const contentTypes = (tagged: boolean): string =>
  `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${
    tagged
      ? '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>'
      : ""
  }</Types>`;

const packageRelationships = (tagged: boolean): string =>
  `${xmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>${
    tagged
      ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>'
      : ""
  }</Relationships>`;

const document = (text: string): string =>
  `${xmlHeader}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs(text)}</w:body></w:document>`;

// The format ID every custom property carries, as the spec gives it.
const customProperties = (key: string): string =>
  `${xmlHeader}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${effectPropertyName}"><vt:lpwstr>${escaped(key)}</vt:lpwstr></property></Properties>`;

/** A Word document of `text`, carrying `key` if there is one. */
export const wordDocument = (text: string, key: string | null): Uint8Array => {
  const tagged = key !== null;
  const entry = (content: string): [Uint8Array, ZipAttributes] => [
    strToU8(content),
    { mtime: zipTime },
  ];
  return zipSync({
    "[Content_Types].xml": entry(contentTypes(tagged)),
    "_rels/.rels": entry(packageRelationships(tagged)),
    "word/document.xml": entry(document(text)),
    ...(tagged ? { "docProps/custom.xml": entry(customProperties(key)) } : {}),
  });
};

/** The largest custom properties part read back. */
const maxPropertiesBytes = 64 * 1024;

/** The `GraspEffect` property's value, in a custom properties part. */
const effectProperty = new RegExp(
  `<property\\b[^>]*\\bname="${effectPropertyName}"[^>]*>\\s*<vt:lpwstr>([^<]*)</vt:lpwstr>`,
  "u"
);

/**
 * The effect key a Word document carries, if it is one and carries one:
 * undefined for anything else, a file that isn't a .docx included.
 */
export const effectKeyOf = (bytes: Uint8Array): string | undefined => {
  let custom: Uint8Array | undefined;
  try {
    custom = unzipSync(bytes, {
      // Only the properties part, and only as large as one key's needs:
      // the file is the person's, and may be anything by now.
      filter: ({ name, originalSize }) =>
        name === "docProps/custom.xml" && originalSize <= maxPropertiesBytes,
    })["docProps/custom.xml"];
  } catch {
    return undefined;
  }
  return custom === undefined
    ? undefined
    : effectProperty.exec(strFromU8(custom))?.[1];
};
