/**
 * Writes the exact bits the int8 path gives for the fixtures' texts
 * (../test/fixtures/int8-bits.json and ../test/fixtures/deep/int8-bits.json:
 * each vector's float32 bytes as hex), for the tests to assert on every CPU
 * they run on. Run after changing a fixture or the module's arithmetic on
 * purpose, and say why in the pull request: a file changing is the integer
 * output changing.
 *
 * Usage: node packages/embed/scripts/fixture-bits.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { Engine, rowBytes } from "../src/engine.ts";
import { readTokensHeader, tokensHeaderBytes } from "../src/model-files.ts";

const wasm = new WebAssembly.Module(
  readFileSync(new URL("../src/embed.wasm", import.meta.url))
);
const whole = (bytes: Uint8Array) => ({
  size: bytes.byteLength,
  parts: [bytes],
});

for (const dir of ["", "deep/"]) {
  const fixtures = new URL(`../test/fixtures/${dir}`, import.meta.url);
  const read = (name: string): Uint8Array =>
    new Uint8Array(readFileSync(new URL(name, fixtures)));
  const engine = new Engine(wasm, {
    encoder: whole(read("encoder-int8.bin")),
    tokenizer: whole(read("tokenizer.bin")),
  });
  const table = read("tokens-int8.bin");
  if (readTokensHeader(table)?.format !== "int8") {
    throw new Error(`${dir}tokens-int8.bin isn't an int8 token table.`);
  }
  const size = rowBytes("int8", engine.dim);
  const rows = (ids: number[]): Map<number, Uint8Array> =>
    new Map(
      ids.map((id) => [
        id,
        table.subarray(
          tokensHeaderBytes + id * size,
          tokensHeaderBytes + (id + 1) * size
        ),
      ])
    );
  const { embeddings } = z
    .object({ embeddings: z.array(z.object({ text: z.string() })) })
    .parse(
      JSON.parse(readFileSync(new URL("reference.json", fixtures), "utf-8"))
    );
  const bits = embeddings.map(({ text }) =>
    Buffer.from(
      engine.embed(engine.tokenize(text), "int8", rows).buffer
    ).toString("hex")
  );
  writeFileSync(
    new URL("int8-bits.json", fixtures),
    `${JSON.stringify(bits, null, 2)}\n`
  );
  console.info(`${dir}int8-bits.json: ${bits.length} vectors`);
}
