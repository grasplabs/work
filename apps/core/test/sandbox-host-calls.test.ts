import { describe, expect, it } from "vite-plus/test";

import {
  readChunkedModules,
  sessionCallOf,
} from "../src/on-prem/sandbox-session.ts";

// What the on-prem sandbox host takes of a session's call
// (src/on-prem/sandbox-session.ts): a parser, so tested on its own. Core
// sends only well-formed calls (src/sandbox-session.ts), so the shapes a
// broken or hostile caller could send are reached here: platform modules
// past their limits, a module named as one of the call's own, a reader
// with nothing to read, the one flag with no platform code to need it,
// and chunks that don't add up to the module.

const MIB = 1024 * 1024;

/** A call of the platform's code: `chunkedModules`, read by `c0`. */
const platformCall = (more: Record<string, unknown> = {}) => ({
  mainModule: "compiler.js",
  modules: {},
  entrypoint: "default",
  method: "build",
  args: [{ value: {} }],
  capabilities: { c0: { function: true } },
  chunkedModules: { "compiler.js": { type: "js", size: 10 } },
  moduleReader: "c0",
  nodejsCompat: true,
  ...more,
});

/** A plain call of an App's code, as core sends one. */
const appCall = (more: Record<string, unknown> = {}) => ({
  mainModule: "m.js",
  modules: { "m.js": "export default {};" },
  entrypoint: "E",
  method: "go",
  args: [],
  capabilities: {},
  nodejsCompat: false,
  ...more,
});

/** A reader of `chunks`, one per call, whatever it's asked. */
const readerOf = (chunks: unknown[]) => {
  let next = 0;
  return async (): Promise<unknown> => {
    await Promise.resolve();
    const chunk = chunks[next];
    next += 1;
    return chunk;
  };
};

const encoder = new TextEncoder();

describe("the sandbox host's reading of a call", () => {
  it("takes a call of the platform's code, and one of an App's", () => {
    expect(sessionCallOf(platformCall())).toMatchObject({
      nodejsCompat: true,
      chunkedModules: { "compiler.js": { type: "js", size: 10 } },
      moduleReader: "c0",
    });
    expect(sessionCallOf(appCall())).toMatchObject({
      nodejsCompat: false,
      chunkedModules: {},
    });
  });

  it("refuses more than eight chunked modules", () => {
    const nine = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `m${index}.js`,
        { type: "js", size: 1 },
      ])
    );
    const eight = Object.fromEntries(Object.entries(nine).slice(0, 8));

    expect(
      sessionCallOf(platformCall({ chunkedModules: nine }))
    ).toBeUndefined();
    expect(
      sessionCallOf(platformCall({ chunkedModules: eight }))
    ).toBeDefined();
  });

  it("refuses chunked modules past 64 MiB together", () => {
    const over = {
      "a.js": { type: "js", size: 32 * MIB },
      "b.json": { type: "json", size: 32 * MIB + 1 },
    };
    const at = {
      "a.js": { type: "js", size: 32 * MIB },
      "b.json": { type: "json", size: 32 * MIB },
    };

    expect(
      sessionCallOf(platformCall({ chunkedModules: over }))
    ).toBeUndefined();
    expect(sessionCallOf(platformCall({ chunkedModules: at }))).toBeDefined();
  });

  it("refuses a chunked module named as one of the call's own", () => {
    expect(
      sessionCallOf(
        platformCall({ modules: { "compiler.js": "export default {};" } })
      )
    ).toBeUndefined();
  });

  it("refuses a chunked module of another type, or of no size", () => {
    for (const spec of [
      { type: "text", size: 10 },
      { type: "js", size: 0 },
      { type: "js", size: 1.5 },
    ]) {
      expect(
        sessionCallOf(platformCall({ chunkedModules: { "compiler.js": spec } }))
      ).toBeUndefined();
    }
  });

  it("refuses a reader with no chunked modules, or chunked modules with no reader of their own", () => {
    expect(
      sessionCallOf(
        appCall({
          capabilities: { c0: { function: true } },
          moduleReader: "c0",
        })
      )
    ).toBeUndefined();
    expect(
      sessionCallOf(platformCall({ moduleReader: undefined }))
    ).toBeUndefined();
    // Named, but not passed, or passed as an object rather than a function.
    expect(sessionCallOf(platformCall({ moduleReader: "c1" }))).toBeUndefined();
    expect(
      sessionCallOf(
        platformCall({ capabilities: { c0: { methods: ["read"] } } })
      )
    ).toBeUndefined();
  });

  it("refuses nodejs_compat for a call with no platform code", () => {
    expect(sessionCallOf(appCall({ nodejsCompat: true }))).toBeUndefined();
    expect(
      sessionCallOf(platformCall({ nodejsCompat: "yes" }))
    ).toBeUndefined();
  });

  it("reads each chunked module whole, as the type it was sent as", async () => {
    const source = encoder.encode("export default 1;");
    const json = encoder.encode('{"a":[1,2]}');
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const loaded = await readChunkedModules(
      {
        "m.js": { type: "js", size: source.byteLength },
        "k.json": { type: "json", size: json.byteLength },
        "w.wasm": { type: "wasm", size: wasm.byteLength },
      },
      readerOf([
        source.slice(0, 5),
        source.slice(5),
        json,
        wasm.slice(0, 4),
        wasm.slice(4),
      ])
    );
    const loadedWasm = loaded["w.wasm"];

    expect({
      js: loaded["m.js"],
      json: loaded["k.json"],
      wasm:
        typeof loadedWasm === "object" && "wasm" in loadedWasm
          ? [...new Uint8Array(loadedWasm.wasm)]
          : null,
    }).toStrictEqual({
      js: "export default 1;",
      json: { json: { a: [1, 2] } },
      wasm: [...wasm],
    });
  });

  it("fails a module whose chunks are empty, run past its size or aren't bytes", async () => {
    const module = { "m.js": { type: "js" as const, size: 4 } };
    for (const chunks of [
      [new Uint8Array(0)],
      [new Uint8Array(5)],
      [new Uint8Array(2), new Uint8Array(3)],
      ["abcd"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      await expect(
        readChunkedModules(module, readerOf(chunks))
      ).rejects.toThrow("didn't arrive as it was sent");
    }
  });
});
