import { describe, expect, it } from "vite-plus/test";

import { XlsxError, xlsxRows } from "./xlsx.ts";

// From the prototype's `lib/docx.test.ts` ("an Excel sheet as rows").

const encoder = new TextEncoder();

const deflated = async (raw: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([new Uint8Array(raw)])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw"))
    ).arrayBuffer()
  );

/** A zip with these files in it, compressed the way Excel writes them. */
const zipOf = async (files: Record<string, string>): Promise<ArrayBuffer> => {
  const parts: Uint8Array[] = [];
  const entries: Uint8Array[] = [];
  let offset = 0;
  const entriesIn = await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const raw = encoder.encode(content);
      return { name, raw, data: await deflated(raw) };
    })
  );
  for (const { name, raw, data } of entriesIn) {
    const nameBytes = encoder.encode(name);
    const local = new DataView(new ArrayBuffer(30 + nameBytes.length));
    local.setUint32(0, 0x04_03_4b_50, true);
    local.setUint16(8, 8, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    new Uint8Array(local.buffer).set(nameBytes, 30);
    const entry = new DataView(new ArrayBuffer(46 + nameBytes.length));
    entry.setUint32(0, 0x02_01_4b_50, true);
    entry.setUint16(10, 8, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    new Uint8Array(entry.buffer).set(nameBytes, 46);
    parts.push(new Uint8Array(local.buffer), data);
    entries.push(new Uint8Array(entry.buffer));
    offset += local.byteLength + data.length;
  }
  const directory = entries.reduce((sum, each) => sum + each.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06_05_4b_50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directory, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...entries, new Uint8Array(end.buffer)];
  const zip = new Uint8Array(all.reduce((sum, each) => sum + each.length, 0));
  let at = 0;
  for (const each of all) {
    zip.set(each, at);
    at += each.length;
  }
  return zip.buffer;
};

describe("an Excel sheet as rows", () => {
  it("reads cells by their column, shared words and numbers alike, with gaps kept", async () => {
    const book = await zipOf({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Staff" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/sharedStrings.xml":
        "<sst><si><t>Name</t></si><si><t>Team</t></si><si><r><t>Daan </t></r><r><t>Bakker</t></r></si><si><t>Service &amp; claims</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="s"><v>3</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Lisa</t></is></c></row></sheetData></worksheet>',
    });
    await expect(xlsxRows(book)).resolves.toStrictEqual([
      ["Name", "", "Team"],
      ["Daan Bakker", "42", "Service & claims"],
      ["Lisa"],
    ]);
  });

  it("says so when a file is not a workbook", async () => {
    await expect(
      xlsxRows(await zipOf({ "ppt/slides/slide1.xml": "<p:sld/>" }))
    ).rejects.toThrow(XlsxError);
  });
});
