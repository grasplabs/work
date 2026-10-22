import type { RunFileType } from "@grasp-os/shared/run-files";

// Which Office document a ZIP someone else made is (GRA-886): a Word and
// an Excel document are both ZIP packages, told apart only by the content
// type their package declares for its main part (ECMA-376 Part 2, Open
// Packaging Conventions), never by the label the file came with. Read from
// the ZIP's central directory: `_rels/.rels`, for the one part the package
// names its main document, and `[Content_Types].xml`, for that part's
// type, each inflated within a bound, and nothing else of the package.
//
// The rule throughout: refuse anything unusual, never interpret it. A
// package Word, Excel, LibreOffice or Google Docs writes passes; anything
// else is no Office document. The threats, each refused:
// - A macro-enabled document passed off as macro-free (docm, xlsm): the
//   type is read for the part `.rels` names only; a package declaring any
//   other main-document type (macro-enabled, a template, an add-in, a
//   presentation) or a VBA project, or holding an entry whose name says
//   VBA, is refused, whatever else it declares.
// - Declarations a parser would read otherwise: XML is taken only as
//   these two parts are written, an XML declaration, one root in its OPC
//   namespace and its flat children with the attributes OPC gives them;
//   no comment, CDATA, processing instruction, DTD, text or nesting, and
//   no entity anywhere (`&`), so nothing hides behind one. A content type
//   with parameters, a relationship type that is the main document's but
//   for case or space, or a second main document, is refused.
// - Names that compare equal to one reader and not another: part and
//   entry names are printable ASCII, folded for ASCII letters only (so no
//   Kelvin sign is a K), each named once.
// - A ZIP two readers would read differently: its end record must be its
//   last 22 bytes (no comment, so none hides a second one), its central
//   directory exactly before it, every record counted, each local header
//   naming its entry as the central record does, none encrypted, and the
//   entries back to back from the start, so none hides outside the
//   directory. An entry's size must be the bytes it holds or inflates to,
//   within the bound.
// A kept file typed as one of these is named with its extension
// (`runFileNamed`), so a docm can't keep its name either.

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

/** The ZIP records' signatures and their fixed sizes. */
const endSignature = 0x06_05_4b_50;
const endSize = 22;
const centralSignature = 0x02_01_4b_50;
const centralSize = 46;
const localSignature = 0x04_03_4b_50;
const localSize = 30;
const descriptorSignature = 0x08_07_4b_50;
/** A data descriptor after an entry's data, with its signature or none. */
const descriptorSizes = [12, 16] as const;
/** General-purpose flags: encrypted (bits 0, 6 and 13), and sizes after the data (bit 3). */
const encryptedFlags = [0x1, 0x40, 0x20_00] as const;
const sizesAfterFlag = 0x8;

/** Whether `flags` has `flag`, a single bit, set. */
const hasFlag = (flags: number, flag: number): boolean =>
  Math.floor(flags / flag) % 2 === 1;

/** The bytes an entry holds, compressed, and how. */
interface Entry {
  method: number;
  data: Uint8Array;
  size: number;
}

/** A central directory record, as far as the checks need it. */
interface Central {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly compressed: number;
  readonly size: number;
  readonly local: number;
}

/** A name of printable ASCII only: anything else is no name of a package's. */
const asciiName = /^[\u0021-\u007E](?:[\u0020-\u007E]*[\u0021-\u007E])?$/u;

/** `text` in lower case, ASCII letters only, as OPC compares part names. */
const folded = (text: string): string =>
  text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

/** Whether bytes `a` and `b` are the same. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, at) => byte === b[at]);

/**
 * The end of central directory record's central directory: where it
 * starts and how many records it holds. Only a record that is the ZIP's
 * last 22 bytes, with no comment, on one disk and no ZIP64 marker: an
 * Office package has no comment, and a record found anywhere else (one in
 * a comment, say) could be another reader's.
 */
const directoryOf = (
  view: DataView
): { start: number; count: number; end: number } | undefined => {
  const end = view.byteLength - endSize;
  if (end < 0 || view.getUint32(end, true) !== endSignature) {
    return undefined;
  }
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  const oneDisk =
    view.getUint16(end + 4, true) === 0 &&
    view.getUint16(end + 6, true) === 0 &&
    view.getUint16(end + 8, true) === count;
  if (
    !oneDisk ||
    view.getUint16(end + 20, true) !== 0 ||
    count === 0xff_ff ||
    start + size !== end
  ) {
    return undefined;
  }
  return { start, count, end };
};

/** The central records from `start`, `count` of them, filling it to `end`. */
const centralsOf = (
  view: DataView,
  bytes: Uint8Array,
  { start, count, end }: { start: number; count: number; end: number }
): Central[] | undefined => {
  const decoder = new TextDecoder();
  const centrals: Central[] = [];
  let at = start;
  for (let index = 0; index < count; index += 1) {
    if (
      at + centralSize > end ||
      view.getUint32(at, true) !== centralSignature
    ) {
      return undefined;
    }
    const nameLength = view.getUint16(at + 28, true);
    const next =
      at +
      centralSize +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
    if (next > end) {
      return undefined;
    }
    const nameBytes = bytes.subarray(
      at + centralSize,
      at + centralSize + nameLength
    );
    const name = decoder.decode(nameBytes);
    const flags = view.getUint16(at + 8, true);
    if (
      !asciiName.test(name) ||
      encryptedFlags.some((flag) => hasFlag(flags, flag))
    ) {
      return undefined;
    }
    centrals.push({
      name,
      nameBytes,
      flags,
      method: view.getUint16(at + 10, true),
      compressed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      local: view.getUint32(at + 42, true),
    });
    at = next;
  }
  // Every record counted, and nothing else in the directory.
  return at === end ? centrals : undefined;
};

/**
 * Where entry `central`'s data starts and ends, if its local header is
 * its central record's: the same name, method and flags (none encrypted).
 */
const localOf = (
  view: DataView,
  bytes: Uint8Array,
  central: Central
): { start: number; end: number } | undefined => {
  const { local } = central;
  if (
    local + localSize > bytes.length ||
    view.getUint32(local, true) !== localSignature
  ) {
    return undefined;
  }
  const nameLength = view.getUint16(local + 26, true);
  const start =
    local + localSize + nameLength + view.getUint16(local + 28, true);
  const name = bytes.subarray(
    local + localSize,
    local + localSize + nameLength
  );
  if (
    !sameBytes(name, central.nameBytes) ||
    view.getUint16(local + 6, true) !== central.flags ||
    view.getUint16(local + 8, true) !== central.method
  ) {
    return undefined;
  }
  return { start, end: start + central.compressed };
};

/**
 * Where the next entry may start after one whose data ends at `end`:
 * there, or past its data descriptor, which bit 3 says follows.
 */
const nextStarts = (
  view: DataView,
  central: Central,
  end: number
): readonly number[] => {
  if (!hasFlag(central.flags, sizesAfterFlag)) {
    return [end];
  }
  return descriptorSizes
    .filter(
      (size) =>
        size === 12 ||
        (end + 4 <= view.byteLength &&
          view.getUint32(end, true) === descriptorSignature)
    )
    .map((size) => end + size);
};

/**
 * A ZIP's entries by name (folded as OPC folds part names), if it is laid
 * out as a plain ZIP: its central directory exactly before its last
 * record, each entry's local header naming it as its central record does,
 * none encrypted, every name printable ASCII and named once, and its
 * entries back to back from its start to its central directory, so no
 * entry hides outside the directory. Anything else is no package.
 */
const entriesOf = (bytes: Uint8Array): Map<string, Entry> | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = directoryOf(view);
  const centrals =
    directory === undefined ? undefined : centralsOf(view, bytes, directory);
  if (directory === undefined || centrals === undefined) {
    return undefined;
  }
  const entries = new Map<string, Entry>();
  const spans: { local: number; ends: readonly number[] }[] = [];
  for (const central of centrals) {
    const name = folded(central.name);
    const span = localOf(view, bytes, central);
    if (span === undefined || entries.has(name)) {
      return undefined;
    }
    entries.set(name, {
      method: central.method,
      data: bytes.subarray(span.start, span.end),
      size: central.size,
    });
    spans.push({
      local: central.local,
      ends: nextStarts(view, central, span.end),
    });
  }
  spans.sort((a, b) => a.local - b.local);
  let expected: readonly number[] = [0];
  for (const { local, ends } of spans) {
    if (!expected.includes(local)) {
      return undefined;
    }
    expected = ends;
  }
  return expected.includes(directory.start) ? entries : undefined;
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

/**
 * An XML name of these parts: ASCII letters only, never a prefix. Space
 * between is XML's own (`[\t\n\r ]`), never another Unicode space.
 */
const xmlName = "[A-Za-z][A-Za-z0-9]*";
/** An attribute value: printable ASCII, and no entity, quote or `<`. */
const valueChars = String.raw`[\u0020-\u0021\u0023-\u0025\u0028-\u003b\u003d-\u007e]*`;
/** The XML declaration, only at the start, as these parts begin. */
const declaration = new RegExp(
  String.raw`^<\?xml(?:[\t\n\r ]+${xmlName}[\t\n\r ]*=[\t\n\r ]*"${valueChars}")*[\t\n\r ]*\?>`,
  "u"
);
const startTag = new RegExp(
  String.raw`<(?<name>${xmlName})(?<attributes>(?:[\t\n\r ]+${xmlName}[\t\n\r ]*=[\t\n\r ]*"${valueChars}")*)[\t\n\r ]*(?<empty>/?)>`,
  "uy"
);
const endTag = new RegExp(String.raw`</(?<name>${xmlName})[\t\n\r ]*>`, "uy");
const attribute = new RegExp(
  String.raw`(?<name>${xmlName})[\t\n\r ]*=[\t\n\r ]*"(?<value>${valueChars})"`,
  "gu"
);
const space = /[\t\n\r ]+/uy;

/** `pattern`'s match at `at`, if it matches there. */
const matchAt = (pattern: RegExp, xml: string, at: number) => {
  pattern.lastIndex = at;
  return pattern.exec(xml);
};

/** An element, by its name and attributes. */
interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
}

/** A start tag's attributes, or undefined if one is given twice. */
const attributesOf = (source: string): Map<string, string> | undefined => {
  const attributes = new Map<string, string>();
  for (const { groups } of source.matchAll(attribute)) {
    const name = groups?.name ?? "";
    if (attributes.has(name)) {
      return undefined;
    }
    attributes.set(name, groups?.value ?? "");
  }
  return attributes;
};

/** Where a parse of one of these parts has got to. */
interface Parse {
  root: XmlElement | undefined;
  readonly children: XmlElement[];
  /** The elements open: the root, then a child of it. */
  readonly open: string[];
  closed: boolean;
}

/**
 * Takes the start tag at `at` into `parse`: where it ends, or undefined
 * unless it is the root or a childless child of it.
 */
const takeStart = (
  xml: string,
  at: number,
  parse: Parse
): number | undefined => {
  const started = matchAt(startTag, xml, at);
  const attributes =
    started === null
      ? undefined
      : attributesOf(started.groups?.attributes ?? "");
  if (
    started === null ||
    attributes === undefined ||
    parse.closed ||
    parse.open.length > 1
  ) {
    return undefined;
  }
  const name = started.groups?.name ?? "";
  const element = { name, attributes };
  if (parse.open.length === 0) {
    parse.root = element;
  } else {
    parse.children.push(element);
  }
  if (started.groups?.empty === "/") {
    parse.closed ||= parse.open.length === 0;
  } else {
    parse.open.push(name);
  }
  return at + started[0].length;
};

/** Takes the end tag at `at` into `parse`, if it ends what is open. */
const takeEnd = (xml: string, at: number, parse: Parse): number | undefined => {
  const ended = matchAt(endTag, xml, at);
  if (ended === null || parse.open.pop() !== ended.groups?.name) {
    return undefined;
  }
  parse.closed ||= parse.open.length === 0;
  return at + ended[0].length;
};

/**
 * `xml` as these parts are written: an XML declaration or none, one root
 * and its children, each childless, with only space between; undefined
 * for anything else. Double-quoted values only, as every writer quotes.
 */
const parsed = (
  xml: string
): { root: XmlElement; children: XmlElement[] } | undefined => {
  const parse: Parse = {
    root: undefined,
    children: [],
    open: [],
    closed: false,
  };
  let at: number | undefined = declaration.exec(xml)?.[0].length ?? 0;
  while (at !== undefined && at < xml.length) {
    const spaced = matchAt(space, xml, at);
    if (spaced) {
      at += spaced[0].length;
    } else {
      at = xml.startsWith("</", at)
        ? takeEnd(xml, at, parse)
        : takeStart(xml, at, parse);
    }
  }
  return at !== undefined && parse.root !== undefined && parse.closed
    ? { root: parse.root, children: parse.children }
    : undefined;
};

/** The attributes each element of these parts may have, and must. */
const elementRules: Readonly<
  Record<string, { allowed: readonly string[]; required: readonly string[] }>
> = {
  Types: { allowed: ["xmlns"], required: ["xmlns"] },
  Default: {
    allowed: ["Extension", "ContentType"],
    required: ["Extension", "ContentType"],
  },
  Override: {
    allowed: ["PartName", "ContentType"],
    required: ["PartName", "ContentType"],
  },
  Relationships: { allowed: ["xmlns"], required: ["xmlns"] },
  Relationship: {
    allowed: ["Id", "Type", "Target", "TargetMode"],
    required: ["Id", "Type", "Target"],
  },
};

/** Whether `element` is named `name` and has the attributes its rule says. */
const isElement = (element: XmlElement, name: string): boolean => {
  const rule = Object.hasOwn(elementRules, name)
    ? elementRules[name]
    : undefined;
  return (
    element.name === name &&
    rule !== undefined &&
    [...element.attributes.keys()].every((key) => rule.allowed.includes(key)) &&
    rule.required.every((key) => element.attributes.has(key))
  );
};

/**
 * `xml`'s children, all named `child`, if its root is `root` in
 * `namespace` and every element has the attributes OPC gives it.
 */
const childrenOf = (
  xml: string,
  root: string,
  namespace: string,
  child: readonly string[]
): readonly XmlElement[] | undefined => {
  const read = parsed(xml);
  if (
    read === undefined ||
    !isElement(read.root, root) ||
    read.root.attributes.get("xmlns") !== namespace ||
    !read.children.every((element) =>
      child.some((name) => isElement(element, name))
    )
  ) {
    return undefined;
  }
  return read.children;
};

/** Entry `name`'s XML, as UTF-8 within the bound, if it is there. */
const xmlOf = async (
  entries: ReadonlyMap<string, Entry>,
  name: string
): Promise<string | undefined> => {
  const entry = entries.get(folded(name));
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

/** A part's path in the package: ASCII segments, never `.` or `..`. */
const partPath = /^\/?(?<path>[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/u;

/** `name` as a part name (`/a/b`), folded, if it is one. */
const partNameOf = (name: string): string | undefined => {
  const path = partPath.exec(name)?.groups?.path;
  return path === undefined ||
    path.split("/").some((segment) => segment === "." || segment === "..")
    ? undefined
    : `/${folded(path)}`;
};

/** Space anywhere, and slashes at the end, which a spelling may add. */
const spelling = /\s+|\/+$/gu;

/** Whether relationship type `type` names a main document, by any spelling. */
const namesMain = (type: string): boolean =>
  folded(type).replaceAll(spelling, "").endsWith("/officedocument");

/**
 * The part name of the package's main document, as its one internal
 * `officeDocument` relationship in `_rels/.rels` names it; undefined for
 * none, several, one whose type is the main document's but spelt
 * otherwise (case, space, a strict package's), repeated IDs, or a target
 * that leaves the package.
 */
const mainPartOf = (rels: string): string | undefined => {
  const relationships = childrenOf(
    rels,
    "Relationships",
    relationshipsNamespace,
    ["Relationship"]
  );
  if (relationships === undefined) {
    return undefined;
  }
  const ids = new Set(
    relationships.map(({ attributes }) => attributes.get("Id"))
  );
  const mains = relationships.filter(({ attributes }) =>
    namesMain(attributes.get("Type") ?? "")
  );
  const [main] = mains;
  if (
    ids.size !== relationships.length ||
    mains.length !== 1 ||
    main?.attributes.get("Type") !== officeDocument ||
    (main.attributes.get("TargetMode") ?? "Internal") !== "Internal"
  ) {
    return undefined;
  }
  return partNameOf(main.attributes.get("Target") ?? "");
};

/** A content type with no parameters: `type/subtype`, ASCII. */
const contentTypePattern =
  /^[A-Za-z0-9][A-Za-z0-9!#$^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$^_.+-]*$/u;
/** A default's extension: ASCII letters and digits. */
const extensionPattern = /^[A-Za-z0-9]+$/u;

/** A default's extension, folded, if it is one. */
const extensionOf = (given: string): string | undefined =>
  extensionPattern.test(given) ? folded(given) : undefined;

/** An override's part name, folded, if it is one, with its leading slash. */
const overridePartOf = (given: string): string | undefined =>
  given.startsWith("/") ? partNameOf(given) : undefined;

/**
 * What `[Content_Types].xml` declares: each `Override`'s type by its part
 * name, and every type it names, `Default`s' too, all folded; undefined
 * unless each names its own part or extension once, the part with a
 * leading slash, and a type with no parameters.
 */
const declarationsOf = (
  xml: string
): { overrides: Map<string, string>; types: Set<string> } | undefined => {
  const children = childrenOf(xml, "Types", contentTypesNamespace, [
    "Default",
    "Override",
  ]);
  if (children === undefined) {
    return undefined;
  }
  const overrides = new Map<string, string>();
  const extensions = new Set<string>();
  const types = new Set<string>();
  for (const { name, attributes } of children) {
    const type = attributes.get("ContentType") ?? "";
    const key =
      name === "Default"
        ? extensionOf(attributes.get("Extension") ?? "")
        : overridePartOf(attributes.get("PartName") ?? "");
    const seen = name === "Default" ? extensions : overrides;
    if (!contentTypePattern.test(type) || key === undefined || seen.has(key)) {
      return undefined;
    }
    if (name === "Default") {
      extensions.add(key);
    } else {
      overrides.set(key, folded(type));
    }
    types.add(folded(type));
  }
  return { overrides, types };
};

/** An entry whose name says it holds VBA, whatever the package declares. */
const isVbaEntry = (name: string): boolean =>
  name.endsWith("vbaproject.bin") ||
  ((name.startsWith("word/") || name.startsWith("xl/")) &&
    name.includes("vba"));

/**
 * The Office document a ZIP's package declares itself to be: Word or
 * Excel, by the content type `[Content_Types].xml` gives the one main
 * part `_rels/.rels` names, an entry of the ZIP; undefined for anything
 * else, a ZIP or a package that is anything but plain, or one declaring
 * or holding any other main document or VBA.
 */
export const officeTypeOf = async (
  bytes: Uint8Array
): Promise<RunFileType | undefined> => {
  const entries = entriesOf(bytes);
  if (entries === undefined || [...entries.keys()].some(isVbaEntry)) {
    return undefined;
  }
  const rels = await xmlOf(entries, relationshipsName);
  const main = rels === undefined ? undefined : mainPartOf(rels);
  const xml =
    main === undefined ? undefined : await xmlOf(entries, contentTypesName);
  const declared = xml === undefined ? undefined : declarationsOf(xml);
  if (
    main === undefined ||
    declared === undefined ||
    !entries.has(main.slice(1))
  ) {
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
