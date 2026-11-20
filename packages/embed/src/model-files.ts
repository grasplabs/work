/**
 * Which model the embedder runs, as its three files (scripts/export.py
 * writes them): the tokenizer and the encoder, which the module reads into
 * its memory, and the token table, one row per token (or, for a trimmed
 * table, per piece the tokenizer keeps: its map writes every other piece
 * as kept ones), which stays in the object's storage and is read row by
 * row. Each file is named by its SHA-256 and found in the model files
 * bucket under `modelFileKey`, so a file is never replaced in place and
 * every copy can be checked.
 *
 * The model is data: its name and its files' hashes and sizes. Each
 * release names the files of `shippedModel` (scripts/release), and each
 * deploy copies them into the deployment's model files bucket
 * (@grasp-os/shared/release), so changing the model is changing this
 * data and nothing else.
 */
import { deployedModelKey } from "@grasp-os/shared/release";

import type { RowFormat } from "./engine.ts";
import { wasmSha256 } from "./wasm-sha256.ts";

/** One model file: its SHA-256 (hex) and its size in bytes. */
export interface ModelFile {
  sha256: string;
  size: number;
}

/** A model the embedder can run. */
export interface EmbedModel {
  /** The model's name, recorded with every vector it makes. */
  name: string;
  tokenizer: ModelFile;
  encoder: ModelFile;
  tokens: ModelFile;
}

/** Which model and build made a vector: its name, and a hash of the module and the model's files. */
export interface ModelIdentity {
  name: string;
  build: string;
}

/** Where a model file is in the model files bucket. */
export const modelFileKey = (file: ModelFile): string =>
  deployedModelKey(file.sha256);

/** The model's three files, each with what it is. */
export const modelFilesOf = (
  model: EmbedModel
): ({ which: "tokenizer" | "encoder" | "tokens" } & ModelFile)[] => [
  { which: "tokenizer", ...model.tokenizer },
  { which: "encoder", ...model.encoder },
  { which: "tokens", ...model.tokens },
];

/**
 * Engram 1, our own: bekko-embedding-v1-a25m (hotchpotch, MIT) cut to 10
 * layers of width 384 and trained again on public text, 256,000 tokens,
 * int8, calibrated (scripts/export.py). The model core ships (GRA-1767).
 */
export const engram1: EmbedModel = {
  name: "engram-1",
  tokenizer: {
    sha256: "e3d06fcbb0cb1e9f0e08051cf1ce82a0f22b679db3aa058458903d646907db44",
    size: 6_891_222,
  },
  encoder: {
    sha256: "587bfd8550cd66ece6f12757bf4eddea33a76d64148eb7e1617cb87def74f6b5",
    size: 19_690_688,
  },
  tokens: {
    sha256: "8dcee5d9a6a2e1189bc3ea03e6394b4f4f9c7110275ddb68541b813ddf655f67",
    size: 99_328_032,
  },
};

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");

/**
 * `model`'s identity as this build of the module runs it: a vector made
 * by another module or other files has another build, so it can be found
 * and made again.
 */
export const modelIdentity = async (
  model: EmbedModel
): Promise<ModelIdentity> => {
  const what = [
    wasmSha256,
    model.tokenizer.sha256,
    model.encoder.sha256,
    model.tokens.sha256,
  ].join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(what)
  );
  return { name: model.name, build: hex(digest).slice(0, 16) };
};

/** The token table file's header: magic, version, format, width, rows, padded to 32 bytes. */
export const tokensHeaderBytes = 32;

/** The row formats by their number in the header. */
const rowFormats: readonly RowFormat[] = ["float", "int8"];

/** What the token table file's header says. */
export interface TokensHeader {
  format: RowFormat;
  dim: number;
  rows: number;
}

/**
 * The model core runs and every release names, the one an `Embedder`
 * loads unless told otherwise. Changing it is this line, in the same
 * change as the new model's files are put in the releases bucket
 * (`vp run release:model-files`): a release that names files the bucket
 * lacks isn't published.
 */
export const shippedModel: EmbedModel = engram1;

/** Reads the token table file's header; null when it isn't one of this version. */
export const readTokensHeader = (bytes: Uint8Array): TokensHeader | null => {
  if (bytes.byteLength < tokensHeaderBytes) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, tokensHeaderBytes);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  const word = (i: number): number => view.getUint32(i * 4, true);
  const format = rowFormats[word(2)];
  if (magic !== "GTKN" || word(1) !== 1 || format === undefined) {
    return null;
  }
  return { format, dim: word(3), rows: word(4) };
};

/** Why the embedder can't run its model: its files are missing or not what the model names. */
export class ModelFilesError extends Error {
  override name = "ModelFilesError";
}
