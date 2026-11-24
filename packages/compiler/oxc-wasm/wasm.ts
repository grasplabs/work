/**
 * oxc.wasm (src/lib.rs), as the Build oxc WASM workflow published it: a
 * pre-release asset of this repo, by the release pin.json names
 * (glue.ts: oxc's commit and the hash of the glue), checked against the
 * SHA-256 it pins. Downloaded once into the compiler's node_modules, by
 * whatever needs it first (build.ts, the repo's tests; in CI, each job's
 * setup, .github/actions/oxc-wasm), never by an install, so installing
 * needs no token; never built on an install, a pull request or a release.
 * A release build bundles it into the compiler's assets, so a deployment
 * never downloads it.
 *
 * A fresh clone needs nothing to download it: the asset's public address
 * takes no token. With `GITHUB_TOKEN` set, it comes through GitHub's API
 * instead, which keeps working if the repo is made private.
 *
 * `node packages/compiler/oxc-wasm/wasm.ts` downloads it if it is missing.
 * Working on the glue: set pin.json's `glue` to what `node glue.ts`
 * prints, build it with build.sh into `oxcWasmPath` and pin `--print`'s
 * hash to try it; then run the Build oxc WASM workflow on the branch
 * (`gh workflow run build-oxc-wasm.yml --ref <branch>`), which publishes
 * the release, and pin the SHA-256 it prints.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { assertGlue, oxcWasmRelease } from "./glue.ts";

const here = import.meta.dirname;

const pinSchema = z.strictObject({
  /**
   * The oxlint and oxfmt it is built from (oxc's tag `oxlint_v<oxlint>`,
   * which releases both), and an exported App installs (the catalog's).
   */
  oxlint: z.string().regex(/^\d+\.\d+\.\d+$/u),
  oxfmt: z.string().regex(/^\d+\.\d+\.\d+$/u),
  /** oxc's commit of the tag `oxlint_v<oxlint>`, which build.sh fetches. */
  oxc: z.string().regex(/^[0-9a-f]{40}$/u),
  /** The hash of the glue it is built with (glue.ts). */
  glue: z.string().regex(/^[0-9a-f]{64}$/u),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const oxcWasmPin = pinSchema.parse(
  JSON.parse(readFileSync(path.join(here, "pin.json"), "utf-8"))
);

/** The release of this repo it is an asset of. */
const release = oxcWasmRelease(oxcWasmPin);

/** Where it is kept, by release: a new pin is a new file. */
export const oxcWasmPath = path.join(
  here,
  `../node_modules/.cache/oxc-wasm/${release}/oxc.wasm`
);

const releaseApi = `https://api.github.com/repos/grasplabs/work/releases/tags/${release}`;

const releaseSchema = z.object({
  assets: z.array(z.object({ name: z.string(), url: z.string() })),
});

const unavailable = (status: number): Error =>
  new Error(
    `Could not download oxc.wasm of the release ${release} of grasplabs/work (${status}). Was the Build oxc WASM workflow run for this glue? If the repo is private, set GITHUB_TOKEN to a token that reads it (GITHUB_TOKEN=$(gh auth token)).`
  );

const bytesOf = async (response: Response): Promise<Uint8Array> => {
  if (!response.ok) {
    throw unavailable(response.status);
  }
  return new Uint8Array(await response.arrayBuffer());
};

/**
 * The pinned release's oxc.wasm: from its public address, with no token,
 * while the repo is public; through GitHub's API with `GITHUB_TOKEN` when
 * it is set, which reads a private repo too. Either way its SHA-256 is
 * checked (`pinned`): the token is for reading, not for trust.
 */
const download = async (): Promise<Uint8Array> => {
  const token = process.env.GITHUB_TOKEN ?? "";
  if (token === "") {
    return await bytesOf(
      await fetch(
        `https://github.com/grasplabs/work/releases/download/${release}/oxc.wasm`
      )
    );
  }
  const headers = {
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  const found = await fetch(releaseApi, {
    headers: { ...headers, accept: "application/vnd.github+json" },
  });
  if (!found.ok) {
    throw unavailable(found.status);
  }
  const asset = releaseSchema
    .parse(await found.json())
    .assets.find(({ name }) => name === "oxc.wasm");
  if (asset === undefined) {
    throw new Error(`The release ${release} has no oxc.wasm`);
  }
  return await bytesOf(
    await fetch(asset.url, {
      headers: { ...headers, accept: "application/octet-stream" },
    })
  );
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const pinned = (bytes: Uint8Array): Uint8Array => {
  const found = sha256(bytes);
  if (found !== oxcWasmPin.sha256) {
    throw new Error(
      `oxc.wasm of ${release} has SHA-256 ${found}, not the ${oxcWasmPin.sha256} packages/compiler/oxc-wasm/pin.json pins`
    );
  }
  return bytes;
};

/**
 * oxc.wasm's bytes, downloaded first if they aren't kept yet: only while
 * the glue is the one it was built with.
 */
export const oxcWasm = async (): Promise<Uint8Array> => {
  assertGlue(oxcWasmPin.glue);
  if (existsSync(oxcWasmPath)) {
    return pinned(readFileSync(oxcWasmPath));
  }
  const bytes = pinned(await download());
  mkdirSync(path.dirname(oxcWasmPath), { recursive: true });
  // Whole or not at all: a build reading it never finds half a file.
  const written = `${oxcWasmPath}.${process.pid}.tmp`;
  writeFileSync(written, bytes);
  renameSync(written, oxcWasmPath);
  return bytes;
};

/**
 * WebAssembly's `Module` as Node has it. The compiler's types are
 * Workers', where a Worker can't compile WebAssembly and `Module` is
 * abstract.
 */
const Module = z
  .custom<new (bytes: Uint8Array) => WebAssembly.Module>(
    (value) => typeof value === "function"
  )
  .parse(Reflect.get(WebAssembly, "Module"));

/** oxc.wasm compiled, in Node: the repo's tests run Grasp's lint on it. */
export const oxcWasmModule = async (): Promise<WebAssembly.Module> =>
  new Module(await oxcWasm());

if (import.meta.main) {
  const { values } = parseArgs({ options: { print: { type: "boolean" } } });
  if (values.print === true) {
    console.info(sha256(readFileSync(oxcWasmPath)));
  } else {
    await oxcWasm();
  }
}
