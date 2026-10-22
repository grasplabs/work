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
    return entry.data;
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
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
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
  const declared = mainParts.filter(([, part]) =>
    xml.includes(`ContentType="${part}"`)
  );
  return declared.length === 1 ? declared[0]?.[0] : undefined;
};
