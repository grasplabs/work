import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { shippedModelPlugin } from "./test/shipped-model-plugin.ts";
import { coreProject } from "./vite.config.ts";

// The Brain evaluation (GRA-1726), on request only: it is in no project the
// root runs, so neither `vp test` nor CI runs it. Run it from the
// repository root with `vp run brain:eval` (scripts/brain-eval.ts), which
// runs this project, scores what it printed and keeps the result.
//
// With vectors: `BRAIN_EVAL_MODEL` names a directory outside the
// repository holding a model's three files as scripts/export.py in
// packages/embed writes them (tokenizer.bin, encoder-int8.bin,
// tokens-int8.bin). The run then has core run that model as if it
// shipped (test/shipped-model-plugin.ts), the files served to core as
// on-prem's release directory serves them (`MODEL_SOURCE`, by SHA-256),
// and the run embeds every passage before it asks. Without it, no model
// ships, as in every deployment today, and recall is by words and exact
// parts alone. The files are never committed.

/** The three files of a model, by the name export.py gives each. */
const modelFileNames = {
  tokenizer: "tokenizer.bin",
  encoder: "encoder-int8.bin",
  tokens: "tokens-int8.bin",
} as const;

/** A model file: its SHA-256, size and bytes. */
const fileIn = (directory: string, name: string) => {
  const bytes = readFileSync(path.join(directory, name));
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    bytes,
  };
};

/** A file as a model names it: its SHA-256 and size. */
const hashed = ({ sha256, size }: { sha256: string; size: number }) => ({
  sha256,
  size,
});

const modelDirectory = process.env.BRAIN_EVAL_MODEL;

const files =
  modelDirectory === undefined
    ? undefined
    : {
        tokenizer: fileIn(modelDirectory, modelFileNames.tokenizer),
        encoder: fileIn(modelDirectory, modelFileNames.encoder),
        tokens: fileIn(modelDirectory, modelFileNames.tokens),
      };

export default coreProject(
  {
    name: "@grasp-os/core:brain-eval",
    include: ["test/brain-eval.test.ts"],
    // It times each recall: nothing else runs beside it.
    fileParallelism: false,
    testTimeout: 10 * 60 * 1000,
  },
  files === undefined
    ? {}
    : {
        // As on-prem's release directory: each file by its SHA-256.
        services: {
          MODEL_SOURCE: (request) => {
            const sha256 = new URL(request.url).pathname.slice(1);
            const file = Object.values(files).find(
              (each) => each.sha256 === sha256
            );
            return file === undefined
              ? new Response(null, { status: 404 })
              : new Response(file.bytes);
          },
        },
        plugins: [
          shippedModelPlugin({
            name: "local",
            tokenizer: hashed(files.tokenizer),
            encoder: hashed(files.encoder),
            tokens: hashed(files.tokens),
          }),
        ],
      }
);
