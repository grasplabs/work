import type { RunFileType } from "@grasp-os/shared/run-files";

// Which Office document a ZIP someone else made is (GRA-886): a Word and
// an Excel document are both ZIP packages, told apart only by the content
// type their package declares for its main part in `[Content_Types].xml`
// (ECMA-376 Part 2, Open Packaging Conventions), never by the label the
// file came with. Read from the ZIP's central directory: the one entry,
// inflated within a bound, and nothing else of the package; anything
// that isn't a well-formed package with exactly one of the two main parts
// is no Office document.

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

/** Most bytes `[Content_Types].xml` may inflate to: a package's is a few KiB. */
const contentTypesMaxBytes = 64 * 1024;

/** The end of central directory record's signature, and its least size. */
const endSignature = 0x06_05_4b_50;
const endMinSize = 22;
/** How far back from the end the record may start: its comment, at most 64 KiB. */
const endSearch = endMinSize + 0xff_ff;
const centralSignature = 0x02_01_4b_50;
const localSignature = 0x04_03_4b_50;

/** The bytes `[Content_Types].xml` holds, compressed, and how. */
interface Entry {
  method: number;
  data: Uint8Array;
  size: number;
}

/** The central directory entry named `[Content_Types].xml`, if the ZIP is well formed. */
const contentTypesEntry = (bytes: Uint8Array): Entry | undefined => {
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
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== centralSignature) {
      return undefined;
    }
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (name === contentTypesName) {
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
        method,
        data: bytes.subarray(start, start + compressed),
        size,
      };
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
};

/** `entry`'s bytes, stored or inflated, unless past `contentTypesMaxBytes`. */
const contentOf = async (entry: Entry): Promise<Uint8Array | undefined> => {
  if (entry.size > contentTypesMaxBytes) {
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
      if (total > contentTypesMaxBytes) {
        break;
      }
      parts.push(value);
    }
  } catch {
    return undefined;
  }
  if (total > contentTypesMaxBytes) {
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

/** Where a parse of `[Content_Types].xml` has got to. */
interface Parse {
  readonly open: string[];
  readonly overrides: string[];
  roots: number;
}

/**
 * Takes start tag `tag` into `parse`, unless its attributes repeat or it
 * would be a second root. Only an `Override` that is a child of the root
 * `Types` declares a content type.
 */
const opened = (tag: RegExpExecArray, parse: Parse): boolean => {
  const { open } = parse;
  const name = tag.groups?.name ?? "";
  const attributes = attributesOf(tag.groups?.attributes ?? "");
  if (attributes === undefined) {
    return false;
  }
  if (open.length === 0) {
    if (parse.roots > 0) {
      return false;
    }
    parse.roots += 1;
  }
  const type = attributes.get("ContentType");
  if (
    name === "Override" &&
    open.length === 1 &&
    open[0] === "Types" &&
    type !== undefined
  ) {
    parse.overrides.push(type);
  }
  if (tag.groups?.empty !== "/") {
    open.push(name);
  }
  return true;
};

/**
 * Takes the markup at `at` into `parse`: where it ends, or undefined if
 * it isn't well formed. A DTD is never taken: a package's content types
 * have none, and its entities could make text into markup.
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
 * The content types `[Content_Types].xml`'s `Override` elements declare,
 * or undefined unless it is well-formed XML with one root: parsed, never
 * searched, so a declaration inside a comment, CDATA or a processing
 * instruction, finished or not, declares nothing, and neither does
 * anything of a document that doesn't parse.
 */
const overrideTypesOf = (xml: string): string[] | undefined => {
  const parse: Parse = { open: [], overrides: [], roots: 0 };
  let at = 0;
  while (at < xml.length) {
    const next = step(xml, at, parse);
    if (next === undefined) {
      return undefined;
    }
    at = next;
  }
  return parse.open.length === 0 && parse.roots === 1
    ? parse.overrides
    : undefined;
};

/**
 * The Office document a ZIP's package declares itself to be: Word or
 * Excel, by the one main part `[Content_Types].xml` names; undefined for
 * anything else, a ZIP that isn't a package, or one naming both.
 */
export const officeTypeOf = async (
  bytes: Uint8Array
): Promise<RunFileType | undefined> => {
  const entry = contentTypesEntry(bytes);
  const content = entry === undefined ? undefined : await contentOf(entry);
  if (content === undefined) {
    return undefined;
  }
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      content
    );
  } catch {
    return undefined;
  }
  const overrides = overrideTypesOf(xml);
  if (overrides === undefined) {
    return undefined;
  }
  const declared = new Set(overrides);
  const found = mainParts.filter(([, part]) => declared.has(part));
  return found.length === 1 ? found[0]?.[0] : undefined;
};
