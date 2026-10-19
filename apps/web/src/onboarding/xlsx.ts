// The first sheet of an Excel workbook as rows of cells, read in the
// browser: a staff list. A workbook is a zip file of XML; the zip is read by
// hand and inflated with the browser's own DecompressionStream, so no
// library is needed. From the prototype's `lib/docx.ts` (`xlsxRows`).

import { onboardingPeopleMax } from "@grasp-os/shared/onboarding";

/** Why a workbook can't be read: not one this reads, or larger than a staff list can be. */
export class XlsxError extends Error {
  readonly reason: "unreadable" | "large";

  constructor(reason: "unreadable" | "large" = "unreadable") {
    super(
      reason === "large"
        ? "This workbook is larger than a staff list Grasp reads."
        : "This is not an Excel workbook Grasp can read."
    );
    this.name = "XlsxError";
    this.reason = reason;
  }
}

/**
 * How large a staff list's workbook may be: as a file, any one part of it
 * once unpacked, and in rows with something in them. The rows are the most
 * people an onboarding takes, with room for a title and headings: a list
 * longer than that could not be kept anyway, and reading it would hold the
 * browser up.
 */
export const xlsxMost = {
  bytes: 10 * 1024 * 1024,
  unpacked: 40 * 1024 * 1024,
  rows: onboardingPeopleMax + 50,
} as const;

const endOfDirectory = 0x06_05_4b_50;
const directoryEntry = 0x02_01_4b_50;
const localHeader = 0x04_03_4b_50;

/** Where the end-of-directory record starts: in the last 64 KB, as its comment is at most that long. */
const endOf = (zip: DataView): number => {
  for (
    let at = zip.byteLength - 22;
    at >= Math.max(0, zip.byteLength - 65_558);
    at -= 1
  ) {
    if (zip.getUint32(at, true) === endOfDirectory) {
      return at;
    }
  }
  return -1;
};

/** The bytes of one file inside a zip, still compressed, with how they were compressed. */
const findEntry = (
  zip: DataView,
  name: string
): { method: number; data: Uint8Array } | null => {
  const end = endOf(zip);
  if (end < 0) {
    return null;
  }
  const count = zip.getUint16(end + 10, true);
  let at = zip.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count && at + 46 <= zip.byteLength; index += 1) {
    if (zip.getUint32(at, true) !== directoryEntry) {
      return null;
    }
    const method = zip.getUint16(at + 10, true);
    const size = zip.getUint32(at + 20, true);
    const nameLength = zip.getUint16(at + 28, true);
    const extraLength = zip.getUint16(at + 30, true);
    const commentLength = zip.getUint16(at + 32, true);
    const local = zip.getUint32(at + 42, true);
    const entryName = decoder.decode(
      new Uint8Array(zip.buffer, zip.byteOffset + at + 46, nameLength)
    );
    if (entryName === name) {
      if (zip.getUint32(local, true) !== localHeader) {
        return null;
      }
      const start =
        local +
        30 +
        zip.getUint16(local + 26, true) +
        zip.getUint16(local + 28, true);
      return {
        method,
        data: new Uint8Array(zip.buffer, zip.byteOffset + start, size),
      };
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
};

/** Unpacks a part, giving up once it comes to more than `xlsxMost.unpacked`: a small file can unpack to a very large one. */
const inflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const reader = new Blob([new Uint8Array(data)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read a chunk at a time
    const { done, value } = await reader.read();
    if (done || length + value.byteLength > xlsxMost.unpacked) {
      length += value?.byteLength ?? 0;
      break;
    }
    length += value.byteLength;
    chunks.push(value);
  }
  if (length > xlsxMost.unpacked) {
    await reader.cancel();
    throw new XlsxError("large");
  }
  const all = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
};

/** One file in a zip as text; none when it is not there, or compressed in a way that cannot be read. */
const entryText = async (
  zip: DataView,
  name: string
): Promise<string | null> => {
  const entry = findEntry(zip, name);
  if (entry === null || (entry.method !== 0 && entry.method !== 8)) {
    return null;
  }
  return new TextDecoder().decode(
    entry.method === 8 ? await inflate(entry.data) : entry.data
  );
};

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const namedEntity = /&(?<name>amp|lt|gt|quot|apos);/gu;
const numberedEntity = /&#(?<code>\d+);/gu;

/** Characters XML writes as entities, back as themselves. */
const unescaped = (text: string): string =>
  text
    .replaceAll(namedEntity, (_, name: string) => entities[name] ?? "")
    .replaceAll(numberedEntity, (_, code: string) =>
      String.fromCodePoint(Number(code))
    );

/** A column's number from its letters: A is 0, Z is 25, AA is 26. */
const columnOf = (letters: string): number => {
  let number = 0;
  for (const letter of letters) {
    number = number * 26 + ((letter.codePointAt(0) ?? 65) - 64);
  }
  return number - 1;
};

const sheetElement = /<sheet\b[^>]*>/u;
const relationId = /\br:id="(?<id>[^"]+)"/u;
const relationship = /<Relationship\b[^>]*>/gu;
const relationshipId = /\bId="(?<value>[^"]*)"/u;
const relationshipTarget = /\bTarget="(?<value>[^"]*)"/u;
const leadingSlash = /^\//u;

/**
 * Where the workbook's first sheet is: the first one `xl/workbook.xml`
 * lists, found through its relationships, since a sheet keeps its file
 * when the sheets are reordered or one is deleted. `sheet1.xml` when the
 * workbook says nothing of it.
 */
const firstSheetPath = async (zip: DataView): Promise<string> => {
  const fallback = "xl/worksheets/sheet1.xml";
  const book = await entryText(zip, "xl/workbook.xml");
  const sheet = book === null ? undefined : sheetElement.exec(book)?.[0];
  const id =
    sheet === undefined ? undefined : relationId.exec(sheet)?.groups?.id;
  const relations = await entryText(zip, "xl/_rels/workbook.xml.rels");
  if (id === undefined || relations === null) {
    return fallback;
  }
  for (const [element] of relations.matchAll(relationship)) {
    const target = relationshipTarget.exec(element)?.groups?.value;
    if (
      relationshipId.exec(element)?.groups?.value === id &&
      target !== undefined
    ) {
      // A target is relative to xl/, or from the package's root when it starts with a slash.
      return target.startsWith("/")
        ? target.replace(leadingSlash, "")
        : `xl/${target}`;
    }
  }
  return fallback;
};

const textRun = /<t(?:\s[^>]*)?>(?<text>[^<]*)<\/t>/gu;
const sharedWord = /<si>(?<word>[\s\S]*?)<\/si>/gu;
const rowElement = /<row\b[^>]*?(?:\/>|>(?<cells>[\s\S]*?)<\/row>)/gu;
const cellElement =
  /<c\b(?<attributes>[^>]*?)(?:\/>|>(?<inner>[\s\S]*?)<\/c>)/gu;
const cellPlace = /\br="(?<column>[A-Z]+)\d+"/u;
const cellKind = /\bt="(?<kind>[^"]+)"/u;
const cellValue = /<v>(?<value>[^<]*)<\/v>/u;

/** A cell's words, with the runs of words written in more than one style joined as they are. */
const runs = (xml: string): string =>
  [...xml.matchAll(textRun)]
    .map((found) => unescaped(found.groups?.text ?? ""))
    .join("");

/** One cell's text: a shared word, words written in the cell, or a number as written. */
const cellText = (
  attributes: string,
  inner: string,
  shared: string[]
): string => {
  const kind = cellKind.exec(attributes)?.groups?.kind;
  const value = cellValue.exec(inner)?.groups?.value ?? "";
  if (kind === "s") {
    return shared[Number(value)] ?? "";
  }
  return kind === "inlineStr" ? runs(inner) : unescaped(value);
};

/**
 * The first sheet of an Excel workbook as rows of cells, as text: a staff
 * list, say. Words come from the workbook's shared words, numbers as
 * written; an empty cell is an empty string. A workbook larger than
 * `xlsxMost` is refused.
 */
export const xlsxRows = async (bytes: ArrayBuffer): Promise<string[][]> => {
  if (bytes.byteLength > xlsxMost.bytes) {
    throw new XlsxError("large");
  }
  const zip = new DataView(bytes);
  const sheet = await entryText(zip, await firstSheetPath(zip));
  if (sheet === null) {
    throw new XlsxError();
  }
  const shared = [
    ...((await entryText(zip, "xl/sharedStrings.xml")) ?? "").matchAll(
      sharedWord
    ),
  ].map((found) => runs(found.groups?.word ?? ""));
  const rows: string[][] = [];
  let filled = 0;
  for (const row of sheet.matchAll(rowElement)) {
    const cells: string[] = [];
    for (const cell of (row.groups?.cells ?? "").matchAll(cellElement)) {
      const attributes = cell.groups?.attributes ?? "";
      const at = cellPlace.exec(attributes)?.groups?.column;
      const text = cellText(attributes, cell.groups?.inner ?? "", shared);
      const index = at === undefined ? cells.length : columnOf(at);
      while (cells.length < index) {
        cells.push("");
      }
      cells[index] = text.trim();
    }
    rows.push(cells);
    if (cells.some((each) => each !== "")) {
      filled += 1;
      if (filled > xlsxMost.rows) {
        throw new XlsxError("large");
      }
    }
  }
  return rows;
};
