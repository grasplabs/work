import type { RunFileType } from "@grasp-os/shared/run-files";

// Which Office document a ZIP someone else made is (GRA-886): a Word and
// an Excel document are both ZIP packages, told apart only by the content
// type their package declares for its main part (ECMA-376 Part 2, Open
// Packaging Conventions), never by the label the file came with. Read from
// the ZIP's central directory: `_rels/.rels`, for the one part the package
// names its main document, and `[Content_Types].xml`, for that part's
// type, each inflated within a bound, and nothing else of the package.
// Both are parsed as XML in their OPC namespaces, never searched. The
// threats, each refused (no Office document):
// - A decoy: a macro-enabled document (docm, xlsm) whose real main part is
//   macro-enabled, with an `Override` of another part declaring the
//   macro-free type. The type is read for the part `.rels` names only,
//   and a package declaring any other main-document type anywhere (macro-
//   enabled, a template, an add-in, a presentation) or a VBA project is
//   refused outright.
// - Declarations that aren't real: in a comment, CDATA or a processing
//   instruction, in XML that doesn't parse, in another namespace, under
//   another element, or an `Override` that names no part.
// - A ZIP that lies about its entries: a size other than the bytes it
//   holds or inflates to, past the bound, or an entry named twice.

const word =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const excel =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The main part's content type of each, as `[Content_Types].xml` names it. */
const mainParts: readonly (readonly [RunFileType, string])[] = [
  [word, `${word}.main+xml`],
  [excel, `${excel}.main+xml`],
  // A macro-free template or a strict package is no document of these.
];

/** The entry that declares a package's content types. */
const contentTypesName = "[Content_Types].xml";
/** The entry that names a package's parts, its main document among them. */
const relationshipsName = "_rels/.rels";

/** The namespaces each is in, as OPC defines them. */
const contentTypesNamespace =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const relationshipsNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";
/** The relationship that names the main document (a transitional one's). */
const officeDocument =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

/**
 * A main document's content type, of any package (`….main+xml`, a binary
 * workbook's `….main`), and a VBA project's: a package declaring one but
 * its own main part's is no document of these.
 */
const mainDocumentType = /\.main(?:\+xml)?$/u;
const vbaProjectType = "application/vnd.ms-office.vbaproject";

/** Most bytes either entry may inflate to: a package's are a few KiB. */
const partMaxBytes = 64 * 1024;

/** The end of central directory record's signature, and its least size. */
const endSignature = 0x06_05_4b_50;
const endMinSize = 22;
/** How far back from the end the record may start: its comment, at most 64 KiB. */
const endSearch = endMinSize + 0xff_ff;
const centralSignature = 0x02_01_4b_50;
const localSignature = 0x04_03_4b_50;

/** The bytes an entry holds, compressed, and how. */
interface Entry {
  method: number;
  data: Uint8Array;
  size: number;
}

/**
 * The entry the central directory record at `at` describes: its bytes,
 * where its local header says they start, if they are within the ZIP.
 */
const localEntry = (view: DataView, at: number): Entry | undefined => {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const compressed = view.getUint32(at + 20, true);
  const local = view.getUint32(at + 42, true);
  if (
    local + 30 > bytes.length ||
    view.getUint32(local, true) !== localSignature
  ) {
    return undefined;
  }
  const start =
    local +
    30 +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  if (start + compressed > bytes.length) {
    return undefined;
  }
  return {
    method: view.getUint16(at + 10, true),
    data: bytes.subarray(start, start + compressed),
    size: view.getUint32(at + 24, true),
  };
};

/**
 * The central directory entry named `wanted`, if the ZIP is well formed
 * and names it once: a second entry by its name could be read in its
 * place by another reader.
 */
const entryNamed = (bytes: Uint8Array, wanted: string): Entry | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let at = bytes.length - endMinSize;
    at >= Math.max(0, bytes.length - endSearch);
    at -= 1
  ) {
    if (view.getUint32(at, true) === endSignature) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    return undefined;
  }
  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  // Compared without case, as OPC compares part names.
  const name = wanted.toLowerCase();
  let found: Entry | undefined;
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== centralSignature) {
      return undefined;
    }
    const nameLength = view.getUint16(at + 28, true);
    const named = decoder
      .decode(bytes.subarray(at + 46, at + 46 + nameLength))
      .toLowerCase();
    if (named === name) {
      const entry = found === undefined ? localEntry(view, at) : undefined;
      if (entry === undefined) {
        return undefined;
      }
      found = entry;
    }
    at +=
      46 +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return found;
};

/** `entry`'s bytes, stored or inflated, unless past `partMaxBytes`. */
const contentOf = async (entry: Entry): Promise<Uint8Array | undefined> => {
  if (entry.size > partMaxBytes) {
    return undefined;
  }
  if (entry.method === 0) {
    // Stored: its bytes are its content, so they must be the size it
    // claims, which the bound above already held.
    return entry.data.length === entry.size ? entry.data : undefined;
  }
  if (entry.method !== 8) {
    return undefined;
  }
  const reader = new Blob([entry.data])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- in order: one piece after another, within the bound
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > partMaxBytes) {
        break;
      }
      parts.push(value);
    }
  } catch {
    return undefined;
  }
  if (total > partMaxBytes) {
    // Inflated no further than the bound: the rest is never made.
    await reader.cancel();
    return undefined;
  }
  if (total !== entry.size) {
    return undefined;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** An XML name, as a package's content types use them. */
const namePattern = String.raw`[A-Za-z_:][\w.:-]*`;
/** The markup XML may hold, each matched where the last one ended. */
const comment = /<!--(?<comment>[\s\S]*?)-->/uy;
const cdata = /<!\[CDATA\[[\s\S]*?\]\]>/uy;
const instruction = new RegExp(
  String.raw`<\?${namePattern}(?:\s[\s\S]*?)?\?>`,
  "uy"
);
const endTag = new RegExp(String.raw`</(?<name>${namePattern})\s*>`, "uy");
const startTag = new RegExp(
  String.raw`<(?<name>${namePattern})(?<attributes>(?:\s+${namePattern}\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(?<empty>/?)>`,
  "uy"
);
const attribute = new RegExp(
  String.raw`(?<name>${namePattern})\s*=\s*(?:"(?<double>[^"<]*)"|'(?<single>[^'<]*)')`,
  "gu"
);
const text = /[^<]+/uy;
const blank = /^\s*$/u;

/** `pattern`'s match at `at`, if it matches there. */
const matchAt = (pattern: RegExp, xml: string, at: number) => {
  pattern.lastIndex = at;
  return pattern.exec(xml);
};

/** A start tag's attributes, or undefined if one is given twice. */
const attributesOf = (
  source: string
): ReadonlyMap<string, string> | undefined => {
  const attributes = new Map<string, string>();
  for (const { groups } of source.matchAll(attribute)) {
    const name = groups?.name ?? "";
    if (attributes.has(name)) {
      return undefined;
    }
    attributes.set(name, groups?.double ?? groups?.single ?? "");
  }
  return attributes;
};

/** An element, by its name and attributes. */
interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
}

/** What a parse of a package's XML part keeps: its root and its children. */
interface Parse {
  readonly open: string[];
  readonly children: XmlElement[];
  root: XmlElement | undefined;
}

/**
 * Takes start tag `tag` into `parse`, unless its attributes repeat, it
 * would be a second root, or it could be in another namespace than its
 * root's: no prefixed element, and no default namespace but the root's.
 */
const opened = (tag: RegExpExecArray, parse: Parse): boolean => {
  const { open } = parse;
  const name = tag.groups?.name ?? "";
  const attributes = attributesOf(tag.groups?.attributes ?? "");
  if (attributes === undefined || name.includes(":")) {
    return false;
  }
  const element = { name, attributes };
  if (open.length === 0) {
    if (parse.root !== undefined) {
      return false;
    }
    parse.root = element;
  } else if (attributes.has("xmlns")) {
    return false;
  } else if (open.length === 1) {
    parse.children.push(element);
  }
  if (tag.groups?.empty !== "/") {
    open.push(name);
  }
  return true;
};

/**
 * Takes the markup at `at` into `parse`: where it ends, or undefined if
 * it isn't well formed. A DTD is never taken: a package's parts have
 * none, and its entities could make text into markup.
 */
const step = (xml: string, at: number, parse: Parse): number | undefined => {
  const { open } = parse;
  const inRoot = open.length > 0;
  const commented = matchAt(comment, xml, at);
  if (commented) {
    // `--` ends a comment's content in XML: none inside one.
    return commented.groups?.comment?.includes("--") === true
      ? undefined
      : at + commented[0].length;
  }
  const instructed = matchAt(instruction, xml, at);
  if (instructed) {
    return at + instructed[0].length;
  }
  const quoted = inRoot ? matchAt(cdata, xml, at) : null;
  if (quoted) {
    return at + quoted[0].length;
  }
  const ended = matchAt(endTag, xml, at);
  if (ended) {
    return open.pop() === ended.groups?.name ? at + ended[0].length : undefined;
  }
  const started = matchAt(startTag, xml, at);
  if (started) {
    return opened(started, parse) ? at + started[0].length : undefined;
  }
  const between = matchAt(text, xml, at);
  if (between && (inRoot || blank.test(between[0]))) {
    return at + between[0].length;
  }
  return undefined;
};

/**
 * `xml`'s root element, in `namespace` and named `root`, and the elements
 * that are its children; undefined unless it is well-formed XML with that
 * one root. Parsed, never searched, so an element inside a comment, CDATA
 * or a processing instruction, finished or not, is none.
 */
const childrenOf = (
  xml: string,
  root: string,
  namespace: string
): readonly XmlElement[] | undefined => {
  const parse: Parse = { open: [], children: [], root: undefined };
  let at = 0;
  while (at < xml.length) {
    const next = step(xml, at, parse);
    if (next === undefined) {
      return undefined;
    }
    at = next;
  }
  return parse.open.length === 0 &&
    parse.root?.name === root &&
    parse.root.attributes.get("xmlns") === namespace
    ? parse.children
    : undefined;
};

/** Entry `name`'s XML, as UTF-8 within the bound, if it is there. */
const xmlOf = async (
  bytes: Uint8Array,
  name: string
): Promise<string | undefined> => {
  const entry = entryNamed(bytes, name);
  const content = entry === undefined ? undefined : await contentOf(entry);
  if (content === undefined) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      content
    );
  } catch {
    return undefined;
  }
};

/** A relationship's target that stays a part of the package, by its name. */
const partTarget = /^\/?(?<path>[\w.-]+(?:\/[\w.-]+)*)$/u;

/**
 * The part name of the package's main document, as its one internal
 * `officeDocument` relationship in `_rels/.rels` names it (lower case, as
 * OPC compares part names); undefined for none, several, or one that
 * leaves the package.
 */
const mainPartOf = (rels: string): string | undefined => {
  const relationships = childrenOf(
    rels,
    "Relationships",
    relationshipsNamespace
  )?.filter(
    ({ name, attributes }) =>
      name === "Relationship" && attributes.get("Type") === officeDocument
  );
  if (relationships?.length !== 1) {
    return undefined;
  }
  const [{ attributes } = { attributes: new Map<string, string>() }] =
    relationships;
  const mode = attributes.get("TargetMode") ?? "Internal";
  const path = partTarget.exec(attributes.get("Target") ?? "")?.groups?.path;
  if (
    mode !== "Internal" ||
    path === undefined ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return `/${path}`.toLowerCase();
};

/**
 * What `[Content_Types].xml` declares: each `Override`'s type by its part
 * name (lower case), and every type it names, `Default`s' too; undefined
 * unless it parses as the OPC namespace's `Types`, holding only `Default`s
 * and `Override`s, each `Override` naming its own part once.
 */
const declarationsOf = (
  xml: string
): { overrides: Map<string, string>; types: Set<string> } | undefined => {
  const children = childrenOf(xml, "Types", contentTypesNamespace);
  if (children === undefined) {
    return undefined;
  }
  const overrides = new Map<string, string>();
  const types = new Set<string>();
  for (const { name, attributes } of children) {
    const type = attributes.get("ContentType")?.toLowerCase();
    const part = attributes.get("PartName")?.toLowerCase();
    const declares =
      name === "Default"
        ? attributes.has("Extension")
        : name === "Override" && part !== undefined && !overrides.has(part);
    if (type === undefined || !declares) {
      return undefined;
    }
    if (part !== undefined && name === "Override") {
      overrides.set(part, type);
    }
    types.add(type);
  }
  return { overrides, types };
};

/**
 * The Office document a ZIP's package declares itself to be: Word or
 * Excel, by the content type `[Content_Types].xml` gives the one main
 * part `_rels/.rels` names; undefined for anything else, a ZIP that isn't
 * a package, or one declaring any other main document or a VBA project.
 */
export const officeTypeOf = async (
  bytes: Uint8Array
): Promise<RunFileType | undefined> => {
  const rels = await xmlOf(bytes, relationshipsName);
  const main = rels === undefined ? undefined : mainPartOf(rels);
  const xml =
    main === undefined ? undefined : await xmlOf(bytes, contentTypesName);
  const declared = xml === undefined ? undefined : declarationsOf(xml);
  if (main === undefined || declared === undefined) {
    return undefined;
  }
  const type = declared.overrides.get(main);
  const others = [...declared.types].filter(
    (named) =>
      named !== type &&
      (mainDocumentType.test(named) || named === vbaProjectType)
  );
  if (others.length > 0) {
    return undefined;
  }
  return mainParts.find(([, part]) => part === type)?.[0];
};
