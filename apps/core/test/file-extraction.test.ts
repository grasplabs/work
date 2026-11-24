import { compatibilityDate } from "@grasp-os/shared/runtime";
import { uploadErrors, uploadTypes } from "@grasp-os/shared/uploads";
import { env } from "cloudflare:workers";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { localExtractor } from "../src/files/extract.ts";
import { extractorAsset } from "../src/files/extractor/asset.ts";
import { outcome } from "./sign-in.ts";

// Core's extractor (src/files/extract.ts), as every file core reads goes
// through it (an upload into the Brain, a chat's file, an onboarding
// document): a PDF, a Word file or a workbook read in a sandbox of its
// own into Markdown, headed as the file is; a file that takes it past
// its limits, or an answer it may not give, refused; and the sandbox
// reaching nothing outside it.

/** A test file, from the fixtures the test assets serve. */
const fixture = async (name: string): Promise<Uint8Array> => {
  const response = await env.ASSETS.fetch(`https://assets/uploads/${name}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** The Markdown core's extractor reads from `bytes`, a file of `type`. */
const extracted = async (
  name: string,
  bytes: Uint8Array,
  extension: keyof typeof uploadTypes = "docx"
): Promise<string> => {
  const { markdown } = await localExtractor(env)({
    name,
    mediaType: uploadTypes[extension],
    bytes,
  });
  return markdown;
};

/** The headings of `markdown`, each without its marks. */
const headingsOf = (markdown: string): string[] =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .map((line) => line.replace(/^#+\s*/u, ""));

/** A Word file of `document.xml` and `styles.xml` as given. */
const wordFile = (document: string, styles: string): Uint8Array => {
  const encoder = new TextEncoder();
  return zipSync({
    "word/document.xml": encoder.encode(document),
    "word/styles.xml": encoder.encode(styles),
  });
};

/**
 * Runs `run` with every sandbox running `extract` (the body of its method,
 * in JavaScript) in place of the extractor's own code: an answer only a
 * broken or subverted extractor gives. Returns how many were started.
 */
const withSandboxAnswering = async (
  extract: string,
  run: () => Promise<void>
): Promise<number> => {
  let started = 0;
  const load = env.LOADER.load.bind(env.LOADER);
  const loading = vi.spyOn(env.LOADER, "load").mockImplementation(() => {
    started += 1;
    return load({
      compatibilityDate,
      mainModule: "extractor.js",
      modules: {
        "extractor.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  extract() { ${extract} }
}`,
      },
    });
  });
  try {
    await run();
  } finally {
    loading.mockRestore();
  }
  return started;
};

/** Text as the bytes of a file. */
const bytesOf = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(new TextEncoder().encode(text));

describe("core's extractor", { timeout: 60_000 }, () => {
  it("reads a PDF by page, a Word file by its headings and a workbook by sheet", async () => {
    const [pdf, docx, xlsx] = await Promise.all([
      extracted(
        "expense-policy.pdf",
        await fixture("expense-policy.pdf"),
        "pdf"
      ),
      extracted("travel-policy.docx", await fixture("travel-policy.docx")),
      extracted("offices.xlsx", await fixture("offices.xlsx"), "xlsx"),
    ]);

    expect({
      pdf: headingsOf(pdf).filter((heading) => heading.startsWith("Page")),
      receipts: pdf.includes("thirty days"),
      docx: ["Travel policy", "Flights"].every((heading) =>
        headingsOf(docx).includes(heading)
      ),
      economy: docx.includes("economy"),
      xlsx: headingsOf(xlsx).includes("Contacts"),
      facilities: xlsx.includes("facilities"),
    }).toStrictEqual({
      pdf: ["Page 1", "Page 2"],
      receipts: true,
      docx: true,
      economy: true,
      xlsx: true,
      facilities: true,
    });
  });

  it("reads text as it is, a CSV as a table, data whole, and a web page and a deck by what they show", async () => {
    const slide = (text: string): Uint8Array =>
      bytesOf(
        `<p:sld xmlns:a="a" xmlns:p="p"><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sld>`
      );
    const [markdown, latin, wide, csv, json, html, deck] = await Promise.all([
      extracted(
        "notes.md",
        bytesOf("# Returns\n\nWithin *thirty* days."),
        "md"
      ),
      // Windows-1252, as an older export is: "Café" with one byte for é.
      extracted("old.txt", new Uint8Array([0x43, 0x61, 0x66, 0xe9]), "txt"),
      // UTF-16 with its byte order mark, as Windows saves "Unicode" text.
      extracted(
        "wide.txt",
        new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]),
        "txt"
      ),
      extracted(
        "offices.csv",
        bytesOf('City,Lead\n"Utrecht, NL",Ada\nGhent,Max\n'),
        "csv"
      ),
      extracted("rules.json", bytesOf('{"note":"uses ``` inside"}'), "json"),
      extracted(
        "handbook.html",
        bytesOf(
          "<!doctype html><title>Handbook</title><style>p{color:red}</style><body><h2>Leave</h2><p hidden>The old policy.</p><p>Ask   your&nbsp;lead <b>first</b>.</p><script>track()</script><ul><li>Two weeks ahead</li></ul><pre>leave:\n  days: 25</pre>"
        ),
        "html"
      ),
      extracted(
        "kickoff.pptx",
        // A deck whose second file was moved to the front: its slide list
        // says the order, not its files' names.
        zipSync({
          "ppt/presentation.xml": bytesOf(
            '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'
          ),
          "ppt/_rels/presentation.xml.rels": bytesOf(
            '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>'
          ),
          "ppt/slides/slide2.xml": slide("Who decides"),
          "ppt/slides/slide1.xml": slide("First &amp; foremost"),
          "ppt/notesSlides/notesSlide1.xml": slide("Not read"),
        }),
        "pptx"
      ),
    ]);

    // A page that is only an empty preformatted block has no text at all:
    // no fence of its own that would read as some.
    await expect(
      extracted("empty.html", bytesOf("<pre>  </pre>"), "html")
    ).resolves.toBe("");
    expect({ markdown, latin, wide, csv, json, html, deck }).toStrictEqual({
      markdown: "# Returns\n\nWithin *thirty* days.",
      latin: "Café",
      wide: "Hi",
      csv: "| City | Lead |\n| --- | --- |\n| Utrecht, NL | Ada |\n| Ghent | Max |",
      json: '````\n{"note":"uses ``` inside"}\n````',
      // What is marked hidden isn't read; a preformatted block keeps its
      // indentation, as a code block.
      html: "# Handbook\n\n## Leave\n\nAsk your lead first.\n\n- Two weeks ahead\n\n```\nleave:\n  days: 25\n```",
      deck: "## Slide 1\n\nWho decides\n\n## Slide 2\n\nFirst & foremost",
    });
  });

  it("reads a sheet of thousands of rows", async () => {
    const markdown = await extracted(
      "orders.xlsx",
      await fixture("orders.xlsx"),
      "xlsx"
    );

    expect({
      sheet: headingsOf(markdown).includes("Orders"),
      row: markdown.includes("Zebra Logistics"),
    }).toStrictEqual({ sheet: true, row: true });
  });

  it("reads workbooks whose parts point at their sheets by relative and absolute paths, or prefix their namespace", async () => {
    const [relative, prefixed] = await Promise.all([
      extracted(
        "offices-relative.xlsx",
        await fixture("offices-relative.xlsx"),
        "xlsx"
      ),
      extracted(
        "offices-prefixed.xlsx",
        await fixture("offices-prefixed.xlsx"),
        "xlsx"
      ),
    ]);

    expect({
      relative: ["Offices", "Contacts"].every((sheet) =>
        headingsOf(relative).includes(sheet)
      ),
      utrecht: relative.includes("Utrecht"),
      prefixed: headingsOf(prefixed).includes("Contacts"),
      upkeep: prefixed.includes("upkeep"),
    }).toStrictEqual({
      relative: true,
      utrecht: true,
      prefixed: true,
      upkeep: true,
    });
  });

  it("reads a Word file of countless unclosed tags in one pass", async () => {
    // Read by patterns that scan on from every unclosed tag, this takes
    // minutes; read in one pass, a moment.
    const unclosed = 200_000;
    const markdown = await extracted(
      "unclosed.docx",
      wordFile(
        `<w:document><w:body>${"<w:p>".repeat(unclosed)}<w:p><w:r><w:t>Still read</w:t></w:r></w:p></w:body></w:document>`,
        `<w:styles>${'<w:style w:styleId="x">'.repeat(unclosed)}</w:styles>`
      )
    );

    expect(markdown).toContain("Still read");
  });

  it("reads a Word file that is only a heading", async () => {
    const markdown = await extracted(
      "title.docx",
      wordFile(
        '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Only a title</w:t></w:r></w:p></w:body></w:document>',
        '<w:styles><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>'
      )
    );

    expect(markdown).toContain("# Only a title");
  });

  it("refuses a file that runs it out of its limits, in one sandbox", async () => {
    let refused = "";
    // As the runtime answers once it stopped the isolate over its limits.
    const started = await withSandboxAnswering(
      'throw new Error("Worker exceeded CPU time limit.");',
      async () => {
        refused = await outcome(
          extracted(
            "expense-policy.pdf",
            await fixture("expense-policy.pdf"),
            "pdf"
          )
        );
      }
    );

    expect({ started, refused }).toStrictEqual({
      started: 1,
      refused: "upload.too_complex",
    });
  });

  it("takes from the sandbox only an answer it may give, within a document's limit", async () => {
    const answers = {
      malformed: 'return { ok: "yes", markdown: 42 };',
      oversized:
        'return { ok: true, markdown: "# Big\\n" + "x".repeat(2 * 1024 * 1024) };',
      unknownReason: 'return { ok: false, reason: "tired" };',
    };
    const bytes = await fixture("travel-policy.docx");
    const refusals: Record<string, string | undefined> = {};
    for (const [name, extract] of Object.entries(answers)) {
      // oxlint-disable-next-line no-await-in-loop -- one sandbox at a time
      await withSandboxAnswering(extract, async () => {
        try {
          await extracted(`${name}.docx`, bytes);
          refusals[name] = "read";
        } catch (error) {
          refusals[name] = uploadErrors.codeOf(error) ?? "refused";
        }
      });
    }

    expect(refusals).toStrictEqual({
      malformed: "refused",
      oversized: "upload.text_too_large",
      unknownReason: "refused",
    });
  });

  it("keeps an extractor that a file took over from reaching out of its sandbox", async () => {
    // What a document that took over pdf.js could run: loaded as core
    // loads the extractor, its own module in place of the extractor's.
    const takenOver = `import { WorkerEntrypoint } from "cloudflare:workers";
import { connect as tcp } from "cloudflare:sockets";
import { connect } from "node:net";

const outcome = async (run) => {
  try {
    await run();
    return "ok";
  } catch (error) {
    return String(error);
  }
};

export default class extends WorkerEntrypoint {
  async extract() {
    const tries = {
      fetch: await outcome(() => fetch("http://169.254.169.254/latest/meta-data/")),
      host: await outcome(() => fetch("http://127.0.0.1:8787/")),
      socket: await outcome(() => tcp("example.com:443").opened),
      net: await outcome(
        () =>
          new Promise((resolve, reject) => {
            const socket = connect(443, "example.com");
            socket.once("connect", resolve);
            socket.once("error", reject);
          })
      ),
    };
    return {
      ok: true,
      markdown: JSON.stringify({ tries, env: Object.keys(this.env), processEnv: Object.keys(process.env) }),
    };
  }
}
`;
    const load = env.LOADER.load.bind(env.LOADER);
    const loading = vi.spyOn(env.LOADER, "load").mockImplementation((code) =>
      // The extractor's own module taken over; the quiet Loader's wrapper
      // around it kept, as core loads it.
      load({ ...code, modules: { ...code.modules, "extractor.js": takenOver } })
    );
    let markdown: string;
    try {
      markdown = await extracted("policy.pdf", new Uint8Array([1]), "pdf");
    } finally {
      loading.mockRestore();
    }
    const reached = z
      .object({
        tries: z.record(z.string(), z.string()),
        env: z.array(z.string()),
        processEnv: z.array(z.string()),
      })
      .parse(JSON.parse(markdown));
    expect({
      ...reached,
      tries: Object.fromEntries(
        Object.entries(reached.tries).map(([name, result]) => [
          name,
          result.includes("not permitted to access the internet"),
        ])
      ),
    }).toStrictEqual({
      tries: { fetch: true, host: true, socket: true, net: true },
      env: [],
      processEnv: [],
    });
  });

  it("is served among core's static assets", async () => {
    const response = await env.ASSETS.fetch(`https://assets/${extractorAsset}`);
    const code = await response.text();

    expect({
      ok: response.ok,
      type: response.headers.get("content-type")?.includes("javascript"),
      entrypoint: code.includes("WorkerEntrypoint"),
    }).toStrictEqual({ ok: true, type: true, entrypoint: true });
  });

  it("can't be reached while its code is missing from the deployment", async () => {
    // A deployment built without the extractor: the assets answer with the
    // frontend's page.
    const assets: Fetcher = {
      ...env.ASSETS,
      fetch: async () =>
        await Promise.resolve(
          new Response("<!doctype html>", {
            headers: { "content-type": "text/html" },
          })
        ),
    };
    const refused = await outcome(
      localExtractor({ ...env, ASSETS: assets })({
        name: "travel-policy.docx",
        mediaType: uploadTypes.docx,
        bytes: await fixture("travel-policy.docx"),
      })
    );

    expect(refused).toBe(
      "ExtractorUnavailableError: The extractor couldn't be reached"
    );
  });
});
