import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ZipAttributes } from "fflate";
import { SaxesParser } from "saxes";
import type { SaxesTagNS } from "saxes";

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

/** What reading an XML part does with each of its elements and texts. */
interface XmlReading {
  open: (tag: SaxesTagNS) => void;
  close: (tag: SaxesTagNS) => void;
  text: (text: string) => void;
}

/**
 * The deepest an element may nest: saxes looks through the elements open
 * around each one for the namespaces its names' prefixes stand for, so an
 * element costs time by its depth. Word's own documents nest a few dozen
 * deep, a text box in a table in a table included.
 */
const maxDepth = 128;

/**
 * Reads the XML part `xml` as XML 1.0 with namespaces (saxes), strictly,
 * its elements and texts in document order, as events: so however deep it
 * nests, it can't exhaust the stack. A DTD is refused, as Office Open XML
 * allows none (ECMA-376 Part 2), so no entity one declares is ever
 * expanded. Throws on anything that isn't well-formed, or nests past
 * {@link maxDepth}.
 */
const readXml = (xml: string, { open, close, text }: XmlReading): void => {
  const parser = new SaxesParser({ xmlns: true, position: false });
  let depth = 0;
  parser.on("doctype", () => {
    parser.fail("an Office Open XML part has no DTD");
  });
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("opentag", (tag) => {
    depth += 1;
    if (depth > maxDepth) {
      parser.fail("this XML nests too deep to read");
    }
    open(tag);
  });
  parser.on("closetag", (tag) => {
    depth -= 1;
    close(tag);
  });
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(xml).close();
};

/** The largest custom properties part read back. */
const maxPropertiesBytes = 64 * 1024;

const customPropertiesNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
const propertyTypesNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";

/** The `GraspEffect` property's value, in a custom properties part. */
const effectPropertyOf = (xml: string): string | undefined => {
  let key: string | undefined;
  let inProperty = false;
  let value: string | undefined;
  readXml(xml, {
    open: ({ uri, local, attributes }) => {
      if (uri === customPropertiesNamespace && local === "property") {
        inProperty = attributes.name?.value === effectPropertyName;
      } else if (
        inProperty &&
        key === undefined &&
        uri === propertyTypesNamespace &&
        local === "lpwstr"
      ) {
        value = "";
      }
    },
    close: ({ uri, local }) => {
      if (
        value !== undefined &&
        uri === propertyTypesNamespace &&
        local === "lpwstr"
      ) {
        key = value;
        value = undefined;
      } else if (uri === customPropertiesNamespace && local === "property") {
        inProperty = false;
      }
    },
    text: (text) => {
      if (value !== undefined) {
        value += text;
      }
    },
  });
  return key;
};

/**
 * The effect key a Word document carries, if it is one and carries one:
 * undefined for anything else, a file that isn't a .docx included.
 */
export const effectKeyOf = (bytes: Uint8Array): string | undefined => {
  try {
    const custom = unzipSync(bytes, {
      // Only the properties part, and only as large as one key's needs:
      // the file is the person's, and may be anything by now.
      filter: ({ name, originalSize }) =>
        name === "docProps/custom.xml" && originalSize <= maxPropertiesBytes,
    })["docProps/custom.xml"];
    return custom === undefined
      ? undefined
      : effectPropertyOf(strFromU8(custom));
  } catch {
    return undefined;
  }
};

/** The largest main document part read back as text. */
const maxDocumentBytes = 16 * 1024 * 1024;

/** WordprocessingML's namespace: as Word saves it, and as Strict Open XML. */
const wordNamespaces: ReadonlySet<string> = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);

/** A WordprocessingML element's local name; `""` for any other element. */
const wordName = ({ uri, local }: SaxesTagNS): string =>
  wordNamespaces.has(uri) ? local : "";

const compatibilityNamespace =
  "http://schemas.openxmlformats.org/markup-compatibility/2006";

/**
 * Whether `tag`, named `name` by `wordName`, holds what the document
 * doesn't show as its text: an alternate content's fallback, which an
 * application shows only when it understands none of the choices before
 * it (ECMA-376 Part 3), and Word understands the choices it writes, so
 * there a fallback is a copy of a choice's text, or text hidden; a
 * tracked deletion, and a tracked move's old place, whose text stands at
 * its new one, as Word shows a document by default. A choice Word doesn't
 * understand, and an ignorable namespace's content, are read all the
 * same, and left to the marking.
 */
const isUnshown = ({ uri, local }: SaxesTagNS, name: string): boolean =>
  (uri === compatibilityNamespace && local === "Fallback") ||
  name === "del" ||
  name === "moveFrom";

/** The value of `tag`'s WordprocessingML attribute `local`, if it has one. */
const wordAttribute = (tag: SaxesTagNS, local: string): string | undefined =>
  Object.values(tag.attributes).find(
    (attribute) =>
      wordNamespaces.has(attribute.uri) && attribute.local === local
  )?.value;

/** A toggle property's values that turn it off (ECMA-376 Part 1, 17.17.4). */
const offValues: ReadonlySet<string> = new Set(["false", "0", "off"]);

/** WordprocessingML Drawing's namespace: as Word saves it, and as Strict. */
const drawingNamespaces: ReadonlySet<string> = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing",
]);

/** A WordprocessingML Drawing element's local name; `""` for any other. */
const drawingName = ({ uri, local }: SaxesTagNS): string =>
  drawingNamespaces.has(uri) ? local : "";

/**
 * Whether a drawing's properties (`wp:docPr`) hide it, as Word's
 * selection pane does: present, but not shown (ECMA-376 Part 1, 20.4.2.5).
 */
const isHiddenDrawing = ({ attributes }: SaxesTagNS): boolean => {
  const hidden = Object.values(attributes).find(
    ({ uri, local }) => uri === "" && local === "hidden"
  )?.value;
  return hidden !== undefined && !offValues.has(hidden);
};

/**
 * Whether `tag` is a run property that hides the run's text (`vanish`,
 * `specVanish`), as Word hides it unless a person asks to see it: the
 * property's own, not one a style gives, which is left to the marking.
 */
const hidesRun = (tag: SaxesTagNS, name: string): boolean => {
  if (name !== "vanish" && name !== "specVanish") {
    return false;
  }
  const value = wordAttribute(tag, "val");
  return value === undefined || !offValues.has(value);
};

/** The body's text: a line per paragraph, its runs' tabs and line breaks kept. */
const bodyText = (xml: string): string => {
  const lines: string[] = [];
  let line: string | undefined;
  /** The open elements, innermost last, each as `wordName` names it. */
  const open: string[] = [];
  let inBody = 0;
  let inUnshown = 0;
  /** The runs open now, innermost last: whether each is hidden. */
  const runs: boolean[] = [];
  /**
   * The fields open now, innermost last: whether each is still in its
   * code, which Word shows only as the field's result.
   */
  const fields: boolean[] = [];
  /** How many of {@link fields} are in their code. */
  let inCode = 0;
  /** The drawings open now, innermost last: whether each is hidden. */
  const drawings: boolean[] = [];
  /** Whether what is read now is the body's, and shown. */
  const reading = (): boolean =>
    inBody > 0 &&
    inUnshown === 0 &&
    inCode === 0 &&
    !runs.includes(true) &&
    !drawings.includes(true);
  /**
   * A field's begin, separator or end, a run's `fldChar`: one in what the
   * document doesn't show (an unused fallback, a deletion) is no field's.
   */
  const fieldChar = (tag: SaxesTagNS): void => {
    if (inUnshown > 0) {
      return;
    }
    const type = wordAttribute(tag, "fldCharType");
    if (type === "begin") {
      fields.push(true);
      inCode += 1;
    } else if (type === "separate" && fields.at(-1) === true) {
      fields[fields.length - 1] = false;
      inCode -= 1;
    } else if (type === "end" && fields.pop() === true) {
      inCode -= 1;
    }
  };
  /**
   * What `tag`, named `name`, opened in `parent`, says of what is shown:
   * a run, a field or a drawing, and whether it hides.
   */
  const opened = (
    tag: SaxesTagNS,
    name: string,
    parent: string | undefined
  ): void => {
    const drawing = drawingName(tag);
    if (drawing === "inline" || drawing === "anchor") {
      drawings.push(false);
    } else if (drawing === "docPr" && isHiddenDrawing(tag)) {
      drawings[drawings.length - 1] = true;
    }
    if (name === "r") {
      runs.push(false);
    } else if (parent === "r" && name === "fldChar") {
      fieldChar(tag);
    } else if (parent === "rPr" && open.at(-2) === "r" && hidesRun(tag, name)) {
      runs[runs.length - 1] = true;
    }
  };
  readXml(xml, {
    open: (tag) => {
      const name = wordName(tag);
      const parent = open.at(-1);
      opened(tag, name, parent);
      open.push(name);
      inBody += name === "body" ? 1 : 0;
      inUnshown += isUnshown(tag, name) ? 1 : 0;
      if (!reading()) {
        return;
      }
      if (name === "p") {
        // A paragraph inside another's open one (a text box's) starts a
        // line of its own.
        if (line !== undefined && line !== "") {
          lines.push(line);
        }
        line = "";
      } else if (parent === "r" && name === "tab") {
        line = `${line ?? ""}\t`;
      } else if (parent === "r" && (name === "br" || name === "cr")) {
        line = `${line ?? ""}\n`;
      }
    },
    close: (tag) => {
      const name = open.pop();
      if (name === "r") {
        runs.pop();
      }
      const drawing = drawingName(tag);
      if (drawing === "inline" || drawing === "anchor") {
        drawings.pop();
      }
      if (reading() && name === "p") {
        lines.push(line ?? "");
        line = undefined;
      }
      inBody -= name === "body" ? 1 : 0;
      inUnshown -= isUnshown(tag, name ?? "") ? 1 : 0;
    },
    text: (text) => {
      if (reading() && open.at(-1) === "t") {
        line = `${line ?? ""}${text}`;
      }
    },
  });
  if (line !== undefined && line !== "") {
    lines.push(line);
  }
  return lines.join("\n");
};

/**
 * A Word document's text: one line per paragraph, its tabs and line breaks
 * kept, everything else (tables' cells, footnotes' marks, fields) as the
 * runs of text they hold. Undefined for anything that isn't a .docx, or
 * whose document part isn't well-formed XML.
 */
export const textOf = (bytes: Uint8Array): string | undefined => {
  try {
    const main = unzipSync(bytes, {
      filter: ({ name, originalSize }) =>
        name === "word/document.xml" && originalSize <= maxDocumentBytes,
    })["word/document.xml"];
    return main === undefined ? undefined : bodyText(strFromU8(main));
  } catch {
    return undefined;
  }
};
