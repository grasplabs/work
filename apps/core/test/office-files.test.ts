import { describe, expect, it } from "vite-plus/test";

import { officeTypeOf } from "../src/workflows/office-files.ts";

const word =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const excel =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const encoder = new TextEncoder();

const deflated = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([bytes])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw"))
    ).arrayBuffer()
  );

interface ZipEntry {
  name: string;
  content: Uint8Array;
  deflate?: boolean;
}

/** A ZIP of `entries`, as an Office package is laid out (CRCs left zero). */
const zipOf = async (entries: readonly ZipEntry[]): Promise<Uint8Array> => {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data =
      entry.deflate === true
        ? // oxlint-disable-next-line no-await-in-loop -- one entry after another, as a ZIP is laid out
          await deflated(entry.content)
        : entry.content;
    const method = entry.deflate === true ? 8 : 0;
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04_03_4b_50, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, entry.content.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02_01_4b_50, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, entry.content.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06_05_4b_50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const contentTypes = (...mains: string[]): Uint8Array =>
  encoder.encode(
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>${mains
      .map(
        (main, index) =>
          `<Override PartName="/part${index}.xml" ContentType="${main}.main+xml"/>`
      )
      .join("")}</Types>`
  );

const body = { name: "word/document.xml", content: encoder.encode("<w/>") };

describe(officeTypeOf, () => {
  it("names a package by the one main part its content types declare, stored or deflated", async () => {
    await expect(
      officeTypeOf(
        await zipOf([
          { name: "[Content_Types].xml", content: contentTypes(word) },
          body,
        ])
      )
    ).resolves.toBe(word);
    await expect(
      officeTypeOf(
        await zipOf([
          body,
          {
            name: "[Content_Types].xml",
            content: contentTypes(excel),
            deflate: true,
          },
        ])
      )
    ).resolves.toBe(excel);
  });

  it("names no type for a ZIP that isn't one of the two documents", async () => {
    const cases = [
      // No content types at all: a plain ZIP, whatever it was labelled.
      await zipOf([body]),
      // Both main parts: neither one.
      await zipOf([
        { name: "[Content_Types].xml", content: contentTypes(word, excel) },
      ]),
      // Another package (a presentation).
      await zipOf([
        {
          name: "[Content_Types].xml",
          content: contentTypes(
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          ),
        },
      ]),
      // The part type named only in an entry by another name.
      await zipOf([
        { name: "docProps/[Content_Types].xml", content: contentTypes(word) },
      ]),
      // Content types that aren't UTF-8.
      await zipOf([
        {
          name: "[Content_Types].xml",
          content: Uint8Array.of(...contentTypes(word), 0xff),
        },
      ]),
    ];
    for (const bytes of cases) {
      // oxlint-disable-next-line no-await-in-loop -- each case on its own
      await expect(officeTypeOf(bytes)).resolves.toBeUndefined();
    }
  });

  it("names no type for a package whose content types inflate past the bound, or a broken ZIP", async () => {
    // A small entry claiming a small size that inflates to far more.
    const bomb = await zipOf([
      {
        name: "[Content_Types].xml",
        content: encoder.encode(
          `${new TextDecoder().decode(contentTypes(word))}${" ".repeat(200 * 1024)}`
        ),
        deflate: true,
      },
    ]);
    const view = new DataView(bomb.buffer);
    const centralAt = view.getUint32(bomb.length - 6, true);
    view.setUint32(centralAt + 24, 100, true);
    await expect(officeTypeOf(bomb)).resolves.toBeUndefined();

    const whole = await zipOf([
      { name: "[Content_Types].xml", content: contentTypes(word) },
    ]);
    for (const broken of [
      whole.subarray(0, -30),
      whole.subarray(10),
      Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each case on its own
      await expect(officeTypeOf(broken)).resolves.toBeUndefined();
    }
  });
});
