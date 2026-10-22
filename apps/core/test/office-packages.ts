// Office packages for tests (GRA-886): ZIPs laid out as Word and Excel
// write them, and the ways a crafted one differs, made on purpose.

export const word =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const excel =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const contentTypesNs =
  "http://schemas.openxmlformats.org/package/2006/content-types";
export const relationshipsNs =
  "http://schemas.openxmlformats.org/package/2006/relationships";
export const officeDocument =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

const encoder = new TextEncoder();

const deflated = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([bytes])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw"))
    ).arrayBuffer()
  );

export interface ZipEntry {
  name: string;
  content: Uint8Array;
  deflate?: boolean;
  /** The name its local header gives, if not its own. */
  localName?: string;
  /** Its general-purpose flags, in both headers. */
  flags?: number;
}

/** `_rels/.rels` holding `relationships`, as written. */
export const relsWith = (...relationships: string[]): ZipEntry => ({
  name: "_rels/.rels",
  content: encoder.encode(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${relationshipsNs}">${relationships.join("")}</Relationships>`
  ),
});

/** A relationship of `type` to `target`, with any more `attributes`. */
export const relationship = (
  id: string,
  target: string,
  type = officeDocument,
  attributes = ""
): string =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"${attributes}/>`;

/** `_rels/.rels`, naming `target` the package's main document. */
export const relsOf = (target = "main.xml", attributes = ""): ZipEntry =>
  relsWith(relationship("rId1", target, officeDocument, attributes));

/** `[Content_Types].xml` holding `children` after the XML default. */
export const types = (...children: string[]): ZipEntry => ({
  name: "[Content_Types].xml",
  content: encoder.encode(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="${contentTypesNs}"><Default Extension="xml" ContentType="application/xml"/>${children.join("")}</Types>`
  ),
});

/** An `Override` of `part` declaring `type`. */
export const override = (part: string, type: string): string =>
  `<Override PartName="${part}" ContentType="${type}"/>`;

/**
 * `[Content_Types].xml`'s bytes declaring `mains`: the first the main
 * document `/main.xml`, the rest other parts.
 */
export const contentTypes = (...mains: string[]): Uint8Array =>
  types(
    ...mains.map((main, index) =>
      override(
        index === 0 ? "/main.xml" : `/part${String(index)}.xml`,
        `${main}.main+xml`
      )
    )
  ).content;

/** The main document part `_rels/.rels` names by default. */
export const body: ZipEntry = {
  name: "main.xml",
  content: encoder.encode("<w/>"),
};

/** The parts of a ZIP: its local entries, central records and end. */
interface Parts {
  locals: Uint8Array[];
  centrals: Uint8Array[];
  offset: number;
}

/** Adds `entry` to `parts`: its local entry, and its central record unless `hidden`. */
const add = async (
  parts: Parts,
  entry: ZipEntry,
  hidden = false
): Promise<void> => {
  const name = encoder.encode(entry.name);
  const localName = encoder.encode(entry.localName ?? entry.name);
  const data =
    entry.deflate === true ? await deflated(entry.content) : entry.content;
  const method = entry.deflate === true ? 8 : 0;
  const flags = entry.flags ?? 0;
  const local = new Uint8Array(30 + localName.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04_03_4b_50, true);
  localView.setUint16(6, flags, true);
  localView.setUint16(8, method, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, entry.content.length, true);
  localView.setUint16(26, localName.length, true);
  local.set(localName, 30);
  local.set(data, 30 + localName.length);
  if (!hidden) {
    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02_01_4b_50, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, entry.content.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, parts.offset, true);
    central.set(name, 46);
    parts.centrals.push(central);
  }
  parts.locals.push(local);
  parts.offset += local.length;
};

/**
 * A ZIP of `entries`, as an Office package is laid out (CRCs left zero),
 * with `_rels/.rels` naming `/main.xml` its main document last, unless
 * `entries` have one of their own or `rels` is false; `hidden` entries
 * have a local entry and no central record, and `comment` follows the
 * end record.
 */
export const zipOf = async (
  given: readonly ZipEntry[],
  {
    rels = true,
    hidden = [],
    comment = new Uint8Array(),
  }: {
    rels?: boolean;
    hidden?: readonly ZipEntry[];
    comment?: Uint8Array;
  } = {}
): Promise<Uint8Array> => {
  const entries =
    rels && !given.some(({ name }) => name === "_rels/.rels")
      ? [...given, relsOf()]
      : given;
  const parts: Parts = { locals: [], centrals: [], offset: 0 };
  for (const entry of entries) {
    // oxlint-disable-next-line no-await-in-loop -- one entry after another, as a ZIP is laid out
    await add(parts, entry);
  }
  for (const entry of hidden) {
    // oxlint-disable-next-line no-await-in-loop -- as above
    await add(parts, entry, true);
  }
  const centralSize = parts.centrals.reduce(
    (sum, part) => sum + part.length,
    0
  );
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06_05_4b_50, true);
  endView.setUint16(8, parts.centrals.length, true);
  endView.setUint16(10, parts.centrals.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, parts.offset, true);
  endView.setUint16(20, comment.length, true);
  const all = [...parts.locals, ...parts.centrals, end, comment];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A Word document's package, as Word writes one, its main part deflated. */
export const docxOf = async (): Promise<Uint8Array> =>
  await zipOf([
    types(
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
      override("/word/document.xml", `${word}.main+xml`)
    ),
    relsOf("word/document.xml"),
    {
      name: "word/document.xml",
      content: encoder.encode("<w:document/>"),
      deflate: true,
    },
  ]);
