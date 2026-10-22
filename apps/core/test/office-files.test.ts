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

const contentTypesNs =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const officeDocument =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

/** `_rels/.rels`, naming `target` the package's main document. */
const relsOf = (target = "main.xml", attributes = ""): ZipEntry => ({
  name: "_rels/.rels",
  content: encoder.encode(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${officeDocument}" Target="${target}"${attributes}/></Relationships>`
  ),
});

/**
 * A ZIP of `entries`, as an Office package is laid out (CRCs left zero),
 * with `_rels/.rels` naming `/main.xml` its main document last, unless
 * `entries` have one of their own or `rels` is false.
 */
const zipOf = async (
  given: readonly ZipEntry[],
  rels = true
): Promise<Uint8Array> => {
  const entries =
    rels && !given.some(({ name }) => name === "_rels/.rels")
      ? [...given, relsOf()]
      : given;
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
          `<Override PartName="${index === 0 ? "/main.xml" : `/part${String(index)}.xml`}" ContentType="${main}.main+xml"/>`
      )
      .join("")}</Types>`
  );

/** An `Override` of `part` declaring `type`. */
const override = (part: string, type: string): string =>
  `<Override PartName="${part}" ContentType="${type}"/>`;

const body = { name: "main.xml", content: encoder.encode("<w/>") };

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
      // The main part named only in a comment and a processing instruction.
      await zipOf([
        {
          name: "[Content_Types].xml",
          content: encoder.encode(
            `<?xml version="1.0"?><!-- <Override PartName="/main.xml" ContentType="${word}.main+xml"/> --><?pi <Override ContentType="${word}.main+xml"?><Types xmlns="${contentTypesNs}"/>`
          ),
        },
      ]),
      // The main part named only in a comment never finished.
      await zipOf([
        {
          name: "[Content_Types].xml",
          content: encoder.encode(
            `<?xml version="1.0"?><Types xmlns="${contentTypesNs}"><!-- <Override PartName="/main.xml" ContentType="${word}.main+xml"/></Types>`
          ),
        },
      ]),
      // ...in CDATA, finished or not.
      ...(await Promise.all(
        ["]]>", ""].map(
          async (close) =>
            await zipOf([
              {
                name: "[Content_Types].xml",
                content: encoder.encode(
                  `<Types xmlns="${contentTypesNs}"><![CDATA[<Override PartName="/main.xml" ContentType="${word}.main+xml"/>${close}</Types>`
                ),
              },
            ])
        )
      )),
      // Declarations in XML that doesn't parse: unbalanced, two roots,
      // a DTD, `--` inside a comment, a stray `<`.
      ...(await Promise.all(
        [
          `<Types xmlns="${contentTypesNs}"><Override PartName="/main.xml" ContentType="${word}.main+xml"/>`,
          `<Types xmlns="${contentTypesNs}"/><Types xmlns="${contentTypesNs}"><Override PartName="/main.xml" ContentType="${word}.main+xml"/></Types>`,
          `<!DOCTYPE Types><Types xmlns="${contentTypesNs}"><Override PartName="/main.xml" ContentType="${word}.main+xml"/></Types>`,
          `<Types xmlns="${contentTypesNs}"><!-- a -- b --><Override PartName="/main.xml" ContentType="${word}.main+xml"/></Types>`,
          `<Types xmlns="${contentTypesNs}">< <Override PartName="/main.xml" ContentType="${word}.main+xml"/></Types>`,
          `<Types xmlns="${contentTypesNs}"><Override PartName="/main.xml" ContentType="${word}.main+xml" ContentType="x"/></Types>`,
        ].map(
          async (xml) =>
            await zipOf([
              { name: "[Content_Types].xml", content: encoder.encode(xml) },
            ])
        )
      )),
      // An `Override` that isn't a child of the root `Types`.
      await zipOf([
        {
          name: "[Content_Types].xml",
          content: encoder.encode(
            `<Types xmlns="${contentTypesNs}"><Other><Override PartName="/main.xml" ContentType="${word}.main+xml"/></Other></Types>`
          ),
        },
      ]),
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

  it("reads the type of the one main part .rels names, and refuses a decoy, another main document, a VBA project or declarations it can't trust", async () => {
    const types = (...children: string[]): ZipEntry => ({
      name: "[Content_Types].xml",
      content: encoder.encode(
        `<?xml version="1.0"?><Types xmlns="${contentTypesNs}"><Default Extension="xml" ContentType="application/xml"/>${children.join("")}</Types>`
      ),
    });
    const docm = "application/vnd.ms-word.document.macroEnabled.main+xml";
    const xlsm = "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
    // A real package: its main part under a folder, named with a leading
    // slash or none, in any case.
    const real = await zipOf(
      [
        types(override("/xl/workbook.xml", `${excel}.main+xml`)),
        relsOf("/XL/Workbook.xml"),
      ],
      false
    );
    const cases = {
      // A docm whose macro-enabled main part .rels names, with a decoy
      // part declaring the macro-free type.
      decoyDocm: await zipOf([
        types(
          override("/main.xml", docm),
          override("/decoy.xml", `${word}.main+xml`)
        ),
      ]),
      decoyXlsm: await zipOf([
        types(
          override("/main.xml", xlsm),
          override("/decoy.xml", `${excel}.main+xml`)
        ),
      ]),
      // The allowed type on the main part, another main document elsewhere.
      otherMain: await zipOf([
        types(
          override("/main.xml", `${word}.main+xml`),
          override("/other.xml", docm)
        ),
      ]),
      // ...or by a Default, or a VBA project beside it.
      otherDefault: await zipOf([
        types(
          override("/main.xml", `${word}.main+xml`),
          `<Default Extension="bin" ContentType="${docm}"/>`
        ),
      ]),
      vbaProject: await zipOf([
        types(
          override("/main.xml", `${word}.main+xml`),
          override(
            "/word/vbaProject.bin",
            "application/vnd.ms-office.vbaProject"
          )
        ),
      ]),
      // The type declared for another part than .rels names, or none.
      notTheMainPart: await zipOf([
        types(override("/decoy.xml", `${word}.main+xml`)),
      ]),
      noRels: await zipOf(
        [types(override("/main.xml", `${word}.main+xml`))],
        false
      ),
      externalMain: await zipOf([
        types(override("/main.xml", `${word}.main+xml`)),
        relsOf("main.xml", ' TargetMode="External"'),
      ]),
      mainOutside: await zipOf([
        types(override("/main.xml", `${word}.main+xml`)),
        relsOf("../main.xml"),
      ]),
      // An Override naming no part, or the main part twice.
      noPartName: await zipOf([
        types(
          override("/main.xml", `${word}.main+xml`),
          `<Override ContentType="${word}.main+xml"/>`
        ),
      ]),
      partTwice: await zipOf([
        types(
          override("/main.xml", `${word}.main+xml`),
          override("/MAIN.xml", docm)
        ),
      ]),
      // Content types in another namespace, or an element in its own.
      foreignNamespace: await zipOf([
        {
          name: "[Content_Types].xml",
          content: encoder.encode(
            `<Types xmlns="urn:evil">${override("/main.xml", `${word}.main+xml`)}</Types>`
          ),
        },
      ]),
      prefixedChild: await zipOf([
        types(
          override("/main.xml", `${word}.main+xml`),
          `<x:Override xmlns:x="${contentTypesNs}" PartName="/other.xml" ContentType="${docm}"/>`
        ),
      ]),
      // A second [Content_Types].xml another reader could take instead.
      twoContentTypes: await zipOf([
        types(override("/main.xml", `${word}.main+xml`)),
        types(override("/main.xml", docm)),
      ]),
    };
    const named: Record<string, string | undefined> = {};
    for (const [label, bytes] of Object.entries(cases)) {
      // oxlint-disable-next-line no-await-in-loop -- each case on its own
      named[label] = await officeTypeOf(bytes);
    }
    expect({ real: await officeTypeOf(real), named }).toStrictEqual({
      real: excel,
      named: Object.fromEntries(
        Object.keys(cases).map((label) => [label, undefined])
      ),
    });
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

    // A stored entry claiming a small size while carrying far more, and a
    // deflated one inflating to other than the size it claims.
    const padded = encoder.encode(
      `${new TextDecoder().decode(contentTypes(word))}${" ".repeat(200 * 1024)}`
    );
    const stored = await zipOf([
      { name: "[Content_Types].xml", content: padded },
    ]);
    const storedView = new DataView(stored.buffer);
    const storedCentral = storedView.getUint32(stored.length - 6, true);
    storedView.setUint32(storedCentral + 24, contentTypes(word).length, true);
    await expect(officeTypeOf(stored)).resolves.toBeUndefined();
    const short = await zipOf([
      {
        name: "[Content_Types].xml",
        content: contentTypes(word),
        deflate: true,
      },
    ]);
    const shortView = new DataView(short.buffer);
    const shortCentral = shortView.getUint32(short.length - 6, true);
    shortView.setUint32(shortCentral + 24, contentTypes(word).length + 1, true);
    await expect(officeTypeOf(short)).resolves.toBeUndefined();

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
