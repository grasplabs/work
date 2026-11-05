/**
 * oxc.wasm (src/lib.rs), as the Build oxc WASM workflow published it: a
 * pre-release asset of this repo, by the release pin.json names, checked
 * against the SHA-256 it pins. Downloaded once into the compiler's
 * node_modules, by `vp install` (the root's `prepare`) and by whatever
 * needs it first (build.ts, the repo's tests); never built on an install,
 * a pull request or a release. A release build bundles it into the
 * compiler's assets, so a deployment never downloads it.
 *
 * It comes through GitHub's API with a token, never a public URL, so it
 * works as well while the repo is private: `GITHUB_TOKEN` (CI's), or the
 * GitHub CLI's sign-in (`gh auth login`).
 *
 * `node packages/compiler/oxc-wasm/wasm.ts` downloads it if it is missing.
 * Working on src/lib.rs: build it with build.sh into `oxcWasmPath`, print
 * its hash with `--print` for the pin; once merged, the workflow publishes
 * it.
 */
import { execFileSync } from "node:child_process";
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

const here = import.meta.dirname;

const pinSchema = z.strictObject({
  /**
   * The oxlint and oxfmt it is built from (oxc's tag `oxlint_v<oxlint>`,
   * which releases both), and an exported App installs (the catalog's).
   */
  oxlint: z.string().regex(/^\d+\.\d+\.\d+$/u),
  oxfmt: z.string().regex(/^\d+\.\d+\.\d+$/u),
  /** The release of this repo it is an asset of. */
  release: z.string().regex(/^oxc-wasm-v\d+\.\d+\.\d+-\d+$/u),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const oxcWasmPin = pinSchema.parse(
  JSON.parse(readFileSync(path.join(here, "pin.json"), "utf-8"))
);

/** Where it is kept, by release: a new pin is a new file. */
export const oxcWasmPath = path.join(
  here,
  `../node_modules/.cache/oxc-wasm/${oxcWasmPin.release}/oxc.wasm`
);

const releaseApi = `https://api.github.com/repos/grasplabs/work/releases/tags/${oxcWasmPin.release}`;

/** A token that reads this repo's releases: CI's, or the GitHub CLI's. */
const githubToken = (): string => {
  const set = process.env.GITHUB_TOKEN;
  if (set !== undefined && set !== "") {
    return set;
  }
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "Downloading oxc.wasm needs a GitHub token that reads grasplabs/work: sign in with `gh auth login`, or set GITHUB_TOKEN"
    );
  }
};

const releaseSchema = z.object({
  assets: z.array(z.object({ name: z.string(), url: z.string() })),
});

/** The pinned release's oxc.wasm, through GitHub's API. */
const download = async (): Promise<Uint8Array> => {
  const headers = {
    authorization: `Bearer ${githubToken()}`,
    "x-github-api-version": "2022-11-28",
  };
  const release = await fetch(releaseApi, {
    headers: { ...headers, accept: "application/vnd.github+json" },
  });
  if (!release.ok) {
    throw new Error(
      `Could not read the release ${oxcWasmPin.release} of grasplabs/work (${release.status}): is the token signed in to it?`
    );
  }
  const asset = releaseSchema
    .parse(await release.json())
    .assets.find(({ name }) => name === "oxc.wasm");
  if (asset === undefined) {
    throw new Error(`The release ${oxcWasmPin.release} has no oxc.wasm`);
  }
  const response = await fetch(asset.url, {
    headers: { ...headers, accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(
      `Could not download oxc.wasm of ${oxcWasmPin.release} (${response.status})`
    );
  }
  return new Uint8Array(await response.arrayBuffer());
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const pinned = (bytes: Uint8Array): Uint8Array => {
  const found = sha256(bytes);
  if (found !== oxcWasmPin.sha256) {
    throw new Error(
      `oxc.wasm of ${oxcWasmPin.release} has SHA-256 ${found}, not the ${oxcWasmPin.sha256} packages/compiler/oxc-wasm/pin.json pins`
    );
  }
  return bytes;
};

/** oxc.wasm's bytes, downloaded first if they aren't kept yet. */
export const oxcWasm = async (): Promise<Uint8Array> => {
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
