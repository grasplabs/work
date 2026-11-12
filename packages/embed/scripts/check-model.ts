/**
 * Checks a real model's files against its reference, in Node, by hand:
 * what CI can't, as the files are hundreds of megabytes. Reads the model
 * files export.py wrote (`--files <dir>`: tokenizer.bin,
 * encoder-int8.bin or encoder-float.bin, and the matching tokens file)
 * and a reference (`--reference <file>`: `{ embeddings: [{ text, ids,
 * vector }], tokens: [{ text, ids }] }`, from Hugging Face tokenizers and
 * transformers in float32; token references may be untruncated). Prints:
 *
 * - token IDs equal to the reference's, for every text and token case,
 *   cut at the model's max tokens as the reference's truncation cuts;
 * - cosine to the reference vectors, least and mean, and how often a
 *   text's nearest other text is the reference's;
 * - whether the i32-dot and i16-pair kernels give the same bits, and
 *   which one this CPU runs;
 * - the module's memory, and the time to embed the longest texts.
 *
 * Usage: node packages/embed/scripts/check-model.ts --files <dir> --reference <file> [--float]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { Engine, rowBytes } from "../src/engine.ts";
import type { FileBytes, Kernel, RowFormat } from "../src/engine.ts";
import { readTokensHeader, tokensHeaderBytes } from "../src/model-files.ts";

const tokenCase = z.object({ text: z.string(), ids: z.array(z.number()) });
const referenceSchema = z.object({
  embeddings: z.array(tokenCase.extend({ vector: z.array(z.number()) })),
  tokens: z.array(tokenCase),
});

const { values: args } = parseArgs({
  options: {
    files: { type: "string" },
    reference: { type: "string" },
    float: { type: "boolean", default: false },
  },
});
if (args.files === undefined || args.reference === undefined) {
  throw new Error(
    "Usage: check-model.ts --files <dir> --reference <file> [--float]"
  );
}
const format: RowFormat = args.float ? "float" : "int8";
const read = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(path.join(args.files ?? "", name)));
const whole = (bytes: Uint8Array): FileBytes => ({
  size: bytes.byteLength,
  parts: [bytes],
});
const wasm = new WebAssembly.Module(
  readFileSync(new URL("../src/embed.wasm", import.meta.url))
);
const encoder = read(`encoder-${format}.bin`);
const tokenizer = read("tokenizer.bin");
const table = read(`tokens-${format}.bin`);
const reference = referenceSchema.parse(
  JSON.parse(readFileSync(args.reference, "utf-8"))
);

const engine = (kernel: Kernel): Engine =>
  new Engine(
    wasm,
    { encoder: whole(encoder), tokenizer: whole(tokenizer) },
    kernel
  );
const auto = engine("auto");
const header = readTokensHeader(table);
if (
  header === null ||
  header.format !== format ||
  header.dim !== auto.dim ||
  header.rows !== auto.tableRows
) {
  throw new Error(
    "The token table doesn't belong to this encoder and tokenizer."
  );
}
const size = rowBytes(format, auto.dim);
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

/** The reference's IDs as its truncation at the model's max tokens gives them. */
const truncated = (ids: number[]): number[] =>
  ids.length <= auto.maxTokens
    ? ids
    : [...ids.slice(0, auto.maxTokens - 1), ids.at(-1) ?? 0];
const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
  a.length === b.length && Array.prototype.every.call(a, (x, i) => x === b[i]);
/** A vector's float32 bit patterns: +0 and -0, or two NaNs, differ here. */
const bits = (vector: Float32Array): Uint32Array =>
  new Uint32Array(vector.buffer, vector.byteOffset, vector.length);

let tokensEqual = 0;
const cases = [...reference.embeddings, ...reference.tokens];
for (const { text, ids } of cases) {
  if (same(auto.tokenize(text), truncated(ids))) {
    tokensEqual += 1;
  } else {
    console.info(`token IDs differ: ${JSON.stringify(text).slice(0, 120)}`);
  }
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    s += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return s;
};
const pairs = engine("pairs");
const plain = engine("dot");
const cosines: number[] = [];
const ours: Float32Array[] = [];
let kernelsEqual = 0;
for (const { text, vector } of reference.embeddings) {
  const ids = auto.tokenize(text);
  const v = auto.embed(ids, format, rows);
  ours.push(v);
  cosines.push(dot(v, vector) / Math.sqrt(dot(v, v) * dot(vector, vector)));
  if (
    same(
      bits(pairs.embed(ids, format, rows)),
      bits(plain.embed(ids, format, rows))
    )
  ) {
    kernelsEqual += 1;
  }
}
const nearest = (all: ArrayLike<number>[], i: number): number => {
  let best = -1;
  let score = -2;
  for (const [j, other] of all.entries()) {
    const s = j === i ? -2 : dot(all[i] ?? [], other);
    if (s > score) {
      [best, score] = [j, s];
    }
  }
  return best;
};
const refs = reference.embeddings.map(({ vector }) => vector);
const nearestEqual = ours.filter(
  (_, i) => nearest(ours, i) === nearest(refs, i)
).length;

const longest = reference.embeddings
  .toSorted((a, b) => b.ids.length - a.ids.length)
  .slice(0, 5);
const timings = longest.map(({ text }) => {
  const ids = auto.tokenize(text);
  for (let i = 0; i < 5; i += 1) {
    auto.embed(ids, format, rows);
  }
  const start = performance.now();
  const runs = 20;
  for (let i = 0; i < runs; i += 1) {
    auto.embed(ids, format, rows);
  }
  return `${ids.length} tokens ${((performance.now() - start) / runs).toFixed(1)} ms`;
});

const n = reference.embeddings.length;
console.info(
  JSON.stringify(
    {
      format,
      tokenIds: `${tokensEqual}/${cases.length} equal`,
      cosine: {
        min: Math.min(...cosines),
        mean: cosines.reduce((s, c) => s + c, 0) / n,
      },
      nearestText: `${nearestEqual}/${n} as the reference's`,
      kernels: `${kernelsEqual}/${n} bit-identical (i32 dot, i16 pairs); ${auto.kernel} runs here`,
      memoryMiB: Number((auto.memoryBytes / 2 ** 20).toFixed(1)),
      timings,
    },
    null,
    2
  )
);
