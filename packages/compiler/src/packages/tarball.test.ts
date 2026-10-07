import { describe, expect, it } from "vite-plus/test";

import { TarballRefusedError } from "./refused.ts";
import { extractTarball } from "./tarball.ts";
import type { ExtractLimits } from "./tarball.ts";

// The tarball reader on its own: a parser, so tested in isolation (the
// paths through the package builder's isolate are core's
// test/packages.test.ts). What a hostile archive can do that the
// integration tests can't reach cheaply: bytes that aren't gzip at all,
// one very large file, and paths or PAX records written to mislead.

const encoder = new TextEncoder();

const limits: ExtractLimits = {
  extractedBytes: 128 * 1024 * 1024,
  extractedEntries: 100,
  pathBytes: 1024,
  pathDepth: 64,
};

/** One ustar header, as tar writes it. */
const header = (path: string, size: number, type = "0"): Uint8Array => {
  const block = new Uint8Array(512);
  const put = (text: string, at: number): void => {
    block.set(encoder.encode(text), at);
  };
  put(path, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put(type, 156);
  put("ustar\u000000", 257);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
};

interface Entry {
  path: string;
  content: Uint8Array;
  type?: string;
}

/** A PAX header's content: `<length> <key>=<value>\n` each. */
const pax = (records: Record<string, string>): Uint8Array =>
  encoder.encode(
    Object.entries(records)
      .map(([key, value]) => {
        const body = ` ${key}=${value}\n`;
        let length = body.length + 1;
        while (`${length}${body}`.length !== length) {
          length += 1;
        }
        return `${length}${body}`;
      })
      .join("")
  );

/** A gzipped tarball of `entries`. */
const tarball = async (entries: Entry[]): Promise<Uint8Array> => {
  const parts: Uint8Array[] = [];
  for (const { path, content, type } of entries) {
    parts.push(
      header(path, content.byteLength, type),
      content,
      new Uint8Array((512 - (content.byteLength % 512)) % 512)
    );
  }
  parts.push(new Uint8Array(1024));
  const stream = new Blob(parts)
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const file = (path: string, text: string): Entry => ({
  path,
  content: encoder.encode(text),
});

/** Why `bytes` was refused, or "ok". */
const refusal = async (bytes: Uint8Array): Promise<string> => {
  try {
    await extractTarball(bytes, limits, () => true);
    return "ok";
  } catch (error) {
    if (error instanceof TarballRefusedError) {
      return error.message;
    }
    throw error;
  }
};

describe("the tarball reader", () => {
  it("refuses bytes that aren't gzip, with its own reason", async () => {
    await expect(
      refusal(encoder.encode("this is not a gzip stream at all"))
    ).resolves.toBe("it isn't a gzipped tarball");
  });

  it("reads one large file in time linear in its size", async () => {
    const timeFor = async (size: number): Promise<number> => {
      const bytes = await tarball([
        { path: "package/big.js", content: new Uint8Array(size) },
      ]);
      const started = performance.now();
      const { files } = await extractTarball(bytes, limits, () => true);
      expect(files.get("big.js")?.byteLength).toBe(size);
      return performance.now() - started;
    };
    const small = await timeFor(4 * 1024 * 1024);
    const large = await timeFor(32 * 1024 * 1024);
    // Eight times the bytes: about eight times the time, never the sixty-
    // four a quadratic copy takes. Generous, so a busy machine passes.
    expect(large).toBeLessThan(Math.max(small, 50) * 24);
  });

  it("refuses two paths one file system would take for the same file", async () => {
    await expect(
      refusal(
        await tarball([
          file("package/Index.js", "export const a = 1;"),
          file("package/index.js", "export const b = 2;"),
        ])
      )
    ).resolves.toBe("it has two entries for index.js");
    await expect(
      refusal(
        await tarball([
          file("package/café.js", "1"),
          file("package/café.js", "2"),
        ])
      )
    ).resolves.toBe("it has two entries for café.js");
  });

  it("refuses control characters and bidirectional overrides in paths", async () => {
    const paths = [
      "package/a\u0085b.js",
      "package/evil‮sj.png",
      "package/x⁦y.js",
      "package/tab\there.js",
    ];
    const outcomes = await Promise.all(
      paths.map(async (path) => await refusal(await tarball([file(path, "x")])))
    );
    expect(new Set(outcomes)).toStrictEqual(
      new Set(["an entry's path has control or bidirectional characters"])
    );
  });

  it("refuses PAX records whose length isn't plain digits, and GNU sparse files", async () => {
    const malformed = encoder.encode("+12 path=x\n");
    const sparse = pax({ "GNU.sparse.major": "1", "GNU.sparse.minor": "0" });
    await expect(
      Promise.all([
        refusal(
          await tarball([
            { path: "PaxHeader", content: malformed, type: "x" },
            file("package/a.js", "x"),
          ])
        ),
        refusal(
          await tarball([
            { path: "PaxHeader", content: sparse, type: "x" },
            file("package/a.js", "x"),
          ])
        ),
      ])
    ).resolves.toStrictEqual([
      "a PAX header can't be read",
      "it has a sparse file",
    ]);
  });
});
