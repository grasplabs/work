// The first sheet of an Excel workbook as rows of cells, read in the
// browser: a staff list. A workbook is a zip file of XML; the zip is read by
// hand and inflated with the browser's own DecompressionStream, so no
// library is needed. From the prototype's `lib/docx.ts` (`xlsxRows`).

/** Why a file is not a workbook this can read. */
export class XlsxError extends Error {
  constructor() {
    super("This is not an Excel workbook Grasp can read.");
    this.name = "XlsxError";
  }
}

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

const inflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([new Uint8Array(data)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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

const textRun = /<t(?:\s[^>]*)?>(?<text>[^<]*)<\/t>/gu;
const sharedWord = /<si>(?<word>[\s\S]*?)<\/si>/gu;
const rowElement = /<row\b[^>]*>(?<cells>[\s\S]*?)<\/row>/gu;
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
 * written; an empty cell is an empty string.
 */
export const xlsxRows = async (bytes: ArrayBuffer): Promise<string[][]> => {
  const zip = new DataView(bytes);
  const sheet = await entryText(zip, "xl/worksheets/sheet1.xml");
  if (sheet === null) {
    throw new XlsxError();
  }
  const shared = [
    ...((await entryText(zip, "xl/sharedStrings.xml")) ?? "").matchAll(
      sharedWord
    ),
  ].map((found) => runs(found.groups?.word ?? ""));
  const rows: string[][] = [];
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
  }
  return rows;
};
