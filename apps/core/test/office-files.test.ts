import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { officeTypeOf } from "../src/workflows/office-files.ts";
import {
  body,
  contentTypes,
  contentTypesNs,
  defaultOf,
  docxOf,
  excel,
  officeDocument,
  override,
  relationship,
  relsOf,
  relsWith,
  strictOfficeDocument,
  types,
  typesXml,
  word,
  zipOf,
} from "./office-packages.ts";

const encoder = new TextEncoder();

/** `[Content_Types].xml` of `children` alone, after `head`. */
const only = (head: string, ...children: string[]) =>
  typesXml(
    `${head}<Types xmlns="${contentTypesNs}">${children.join("")}</Types>`
  );

/** What each of `cases` is typed as. */
const typed = async (
  cases: Record<string, Uint8Array>
): Promise<Record<string, string | undefined>> => {
  const named: Record<string, string | undefined> = {};
  for (const [label, bytes] of Object.entries(cases)) {
    // oxlint-disable-next-line no-await-in-loop -- each case on its own
    named[label] = await officeTypeOf(bytes);
  }
  return named;
};

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
    const docm = "application/vnd.ms-word.document.macroEnabled.main+xml";
    const xlsm = "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
    // A real package: its main part under a folder, named with a leading
    // slash or none, in any case.
    const real = await zipOf(
      [
        types(override("/xl/workbook.xml", `${excel}.main+xml`)),
        relsOf("/XL/Workbook.xml"),
        { name: "xl/workbook.xml", content: encoder.encode("<workbook/>") },
      ],
      { rels: false }
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
      noRels: await zipOf([types(override("/main.xml", `${word}.main+xml`))], {
        rels: false,
      }),
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

  it("refuses every way past the macro refusal a review found: entities, parameters, spellings, nesting, look-alike names and ZIPs two readers read apart", async () => {
    const wordMain = `${word}.main+xml`;
    const docm = "application/vnd.ms-word.document.macroEnabled.main+xml";
    const macro = { name: "macro.xml", content: encoder.encode("<w/>") };
    const asWord = types(override("/main.xml", wordMain));
    const whole = [asWord, body];
    const real = await zipOf(whole);
    // A copy of the real end record: the one a reader scanning back
    // from the end finds first, in the comment.
    const fakeEnd = real.slice(-22);
    const cases = {
      // A macro-enabled main type, or a VBA project, behind an entity.
      entityMacro: await zipOf([
        types(
          override("/main.xml", wordMain),
          override(
            "/macro.xml",
            "application/vnd.ms-word.document.macroEnabled.main&#43;xml"
          )
        ),
        body,
        macro,
      ]),
      entityVba: await zipOf([
        types(
          override("/main.xml", wordMain),
          override("/x.bin", "application/vnd.ms-office.vba&#80;roject")
        ),
        body,
      ]),
      // A second main document, its relationship spelt exactly, in upper
      // case, or nested in the first.
      secondMain: await zipOf([
        types(override("/main.xml", wordMain), override("/macro.xml", docm)),
        relsWith(
          relationship("rId1", "main.xml"),
          relationship("rId2", "macro.xml")
        ),
        body,
        macro,
      ]),
      upperCaseType: await zipOf([
        asWord,
        relsWith(
          relationship("rId1", "main.xml"),
          relationship("rId2", "macro.xml", officeDocument.toUpperCase())
        ),
        body,
        macro,
      ]),
      spacedType: await zipOf([
        asWord,
        relsWith(
          relationship("rId1", "main.xml"),
          relationship("rId2", "macro.xml", ` ${officeDocument}`)
        ),
        body,
        macro,
      ]),
      nested: await zipOf([
        asWord,
        {
          name: "_rels/.rels",
          content: encoder.encode(
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${officeDocument}" Target="main.xml">${relationship("rId2", "macro.xml")}</Relationship></Relationships>`
          ),
        },
        body,
        macro,
      ]),
      // A macro-enabled type with parameters, on another part or the main.
      parameters: await zipOf([
        types(
          override("/main.xml", wordMain),
          override("/macro.xml", `${docm}; v=1`)
        ),
        body,
        macro,
      ]),
      mainParameters: await zipOf([
        types(override("/main.xml", `${wordMain}; v=1`)),
        body,
      ]),
      // A Kelvin sign, which folds to K only beyond ASCII.
      kelvinPart: await zipOf([
        types(override("/\u212Amain.xml", wordMain)),
        relsOf("kmain.xml"),
        { name: "kmain.xml", content: encoder.encode("<w/>") },
      ]),
      kelvinEntry: await zipOf([
        asWord,
        body,
        { name: "word/vba\u212A.bin", content: encoder.encode("x") },
      ]),
      // An end record in the comment, or any comment at all.
      fakeEnd: await zipOf(whole, { comment: fakeEnd }),
      // A local header naming another entry than its central record.
      nameMismatch: await zipOf([
        asWord,
        { ...body, localName: "word/vbaProject.bin" },
      ]),
      // Encrypted, by the flag.
      encrypted: await zipOf([asWord, { ...body, flags: 1 }]),
      // A local entry the central directory doesn't list.
      hiddenEntry: await zipOf(whole, {
        hidden: [{ name: "word/vbaProject.bin", content: encoder.encode("x") }],
      }),
      // VBA by its entry's name, whatever the content types say.
      vbaByName: await zipOf([
        asWord,
        body,
        { name: "word/vbaProject.bin", content: encoder.encode("x") },
      ]),
      vbaUnderXl: await zipOf([
        asWord,
        body,
        { name: "xl/VbaData.xml", content: encoder.encode("<x/>") },
      ]),
      // XML a reader could take otherwise: single quotes, a comment, text.
      singleQuoted: await zipOf([
        {
          name: "[Content_Types].xml",
          content: encoder.encode(
            `<Types xmlns='${contentTypesNs}'><Override PartName='/main.xml' ContentType='${wordMain}'/></Types>`
          ),
        },
        body,
      ]),
      unknownAttribute: await zipOf([
        types(
          `<Override PartName="/main.xml" ContentType="${wordMain}" Hidden="1"/>`
        ),
        body,
      ]),
    };
    const named: Record<string, string | undefined> = {};
    for (const [label, bytes] of Object.entries(cases)) {
      // oxlint-disable-next-line no-await-in-loop -- each case on its own
      named[label] = await officeTypeOf(bytes);
    }
    expect({
      real: await officeTypeOf(real),
      docx: await officeTypeOf(await docxOf()),
      named,
    }).toStrictEqual({
      real: word,
      docx: word,
      named: Object.fromEntries(
        Object.keys(cases).map((label) => [label, undefined])
      ),
    });
  });

  it("types the main part the OPC way, by its Override or else its extension's Default, and reads only a declaration that decodes one way", async () => {
    const wordMain = `${word}.main+xml`;
    const docm = "application/vnd.ms-word.document.macroEnabled.main+xml";
    const vba = "application/vnd.ms-office.vbaProject";
    const declaration = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
    const document = (name: string) => ({
      name,
      content: encoder.encode("<w/>"),
    });
    const fetched = await env.ASSETS.fetch(
      "https://assets/uploads/travel-policy.docx"
    );
    const travelPolicy = new Uint8Array(await fetched.arrayBuffer());
    const accepted = {
      // Typed by the Default for its extension, as ClosedXML and the Open
      // XML SDK write it, in either case.
      byDefault: await zipOf([
        only(declaration, defaultOf("xml", wordMain)),
        body,
      ]),
      byUpperCaseDefault: await zipOf([
        only(declaration, defaultOf("XML", wordMain)),
        relsOf("Main.XML"),
        document("Main.XML"),
      ]),
      // A declaration in single quotes, as python-docx writes it.
      singleQuotedDeclaration: await zipOf([
        only(
          `<?xml version='1.0' encoding='UTF-8' standalone='yes'?>`,
          override("/main.xml", wordMain)
        ),
        body,
      ]),
      // A Strict package's main relationship.
      strict: await zipOf([
        types(override("/main.xml", wordMain)),
        relsWith(relationship("rId1", "main.xml", strictOfficeDocument)),
        body,
      ]),
      // A real document of the repo's.
      travelPolicy,
    };
    const refused = {
      macroDefault: await zipOf([
        only(declaration, defaultOf("xml", docm)),
        body,
      ]),
      macroOverOfficeDefault: await zipOf([
        only(
          declaration,
          defaultOf("xml", wordMain),
          override("/main.xml", docm)
        ),
        body,
      ]),
      vbaDefault: await zipOf([
        only(declaration, defaultOf("xml", wordMain), defaultOf("bin", vba)),
        body,
      ]),
      noExtension: await zipOf([
        only(declaration, defaultOf("xml", wordMain)),
        relsOf("main"),
        document("main"),
      ]),
      mixedQuotes: await zipOf([
        only(
          `<?xml version="1.0' encoding="UTF-8"?>`,
          override("/main.xml", wordMain)
        ),
        body,
      ]),
      // A declaration that runs on over the root's start tag.
      swallowingDeclaration: await zipOf([
        typesXml(
          `<?xml version="1.0" encoding="UTF-8" <Types xmlns="${contentTypesNs}">?>${override("/main.xml", wordMain)}</Types>`
        ),
        body,
      ]),
      strictAndTransitional: await zipOf([
        types(
          override("/main.xml", wordMain),
          override("/other.xml", wordMain)
        ),
        relsWith(
          relationship("rId1", "main.xml", strictOfficeDocument),
          relationship("rId2", "other.xml")
        ),
        body,
        document("other.xml"),
      ]),
      strictMacro: await zipOf([
        types(override("/main.xml", docm)),
        relsWith(relationship("rId1", "main.xml", strictOfficeDocument)),
        body,
      ]),
      utf7: await zipOf([
        only(
          `<?xml version="1.0" encoding="UTF-7"?>`,
          override("/main.xml", wordMain)
        ),
        body,
      ]),
      version11: await zipOf([
        only(`<?xml version="1.1"?>`, override("/main.xml", wordMain)),
        body,
      ]),
    };
    expect({
      accepted: await typed(accepted),
      refused: await typed(refused),
    }).toStrictEqual({
      accepted: Object.fromEntries(
        Object.keys(accepted).map((label) => [label, word])
      ),
      refused: Object.fromEntries(
        Object.keys(refused).map((label) => [label, undefined])
      ),
    });
  });

  it("refuses a ZIP64 locator before the end record and an entry's comment, either of which can hold another directory", async () => {
    const whole = await zipOf([
      types(override("/main.xml", `${word}.main+xml`)),
      body,
    ]);
    // A locator in the last 20 bytes before the end record: in a comment
    // the record says there is none of, or past the directory's end.
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, 0x07_06_4b_50, true);
    const end = whole.length - 22;
    const view = new DataView(whole.buffer);
    const directoryAt = view.getUint32(whole.length - 6, true);
    const directorySize = view.getUint32(whole.length - 10, true);
    const withLocator = new Uint8Array(whole.length + 20);
    withLocator.set(whole.subarray(0, end), 0);
    withLocator.set(locator, end);
    withLocator.set(whole.subarray(end), end + 20);
    // ...and the directory grown over it, through its last entry's comment.
    const grown = new DataView(withLocator.buffer);
    grown.setUint32(withLocator.length - 10, directorySize + 20, true);
    let last = directoryAt;
    for (let at = directoryAt; at < end;) {
      last = at;
      at +=
        46 +
        view.getUint16(at + 28, true) +
        view.getUint16(at + 30, true) +
        view.getUint16(at + 32, true);
    }
    grown.setUint16(last + 32, 20, true);
    const commentOnly = new Uint8Array(withLocator);
    // A comment that holds no locator: still a comment.
    commentOnly.fill(0x20, end, end + 20);
    await expect(officeTypeOf(whole)).resolves.toBe(word);
    await expect(officeTypeOf(withLocator)).resolves.toBeUndefined();
    await expect(officeTypeOf(commentOnly)).resolves.toBeUndefined();
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
