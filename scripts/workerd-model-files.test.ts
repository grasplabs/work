/**
 * The on-prem profile's model files on plain workerd: core copies the
 * files of the model it runs from the install's release directory
 * (`MODEL_SOURCE`, workerd-model-files.ts) into its file-backed bucket
 * (workerd-r2.ts), and the embedder runs from there. On the embed
 * package's tiny fixture model, bundled with core's own code
 * (apps/core/test/on-prem-model-files-worker.ts). What can go wrong (the threat model on
 * GRA-1772), each tried below:
 * - The install has the release but its embedder has nothing to load.
 * - A file in the release directory that isn't the release's reaches the
 *   bucket, whole or in part, or gets embedded with.
 * - Model files of releases no longer running pile up.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { modelBlobKey } from "@grasp-os/shared/release";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { bundledModules } from "./workerd-minified-checks.ts";
import {
  modelFilesDir,
  modelSourceBinding,
  modelSourceService,
} from "./workerd-model-files.ts";
import { r2Bindings, r2Services, writeR2Service } from "./workerd-r2.ts";
import {
  cleanUp,
  serveOnWorkerd,
  storageDir,
  tempDir,
} from "./workerd-test-server.ts";

const fixtures = path.join(
  import.meta.dirname,
  "../packages/embed/test/fixtures"
);
const fixtureFiles = z
  .record(z.string(), z.object({ sha256: z.string(), size: z.number() }))
  .parse(JSON.parse(readFileSync(path.join(fixtures, "files.json"), "utf-8")));
/** The fixture int8 model's files, as the worker's model names them. */
const modelFiles = ["tokenizer.bin", "encoder-int8.bin", "tokens-int8.bin"];

const sha256Of = (name: string): string => {
  const file = fixtureFiles[name];
  if (file === undefined) {
    throw new Error(`No fixture ${name}`);
  }
  return file.sha256;
};

/** A release directory holding the fixture model's files, as a download writes them. */
const releaseDir = (): string => {
  const dir = tempDir();
  mkdirSync(modelFilesDir(dir), { recursive: true });
  for (const name of modelFiles) {
    copyFileSync(
      path.join(fixtures, name),
      path.join(dir, modelBlobKey(sha256Of(name)))
    );
  }
  return dir;
};

/** The test Worker, bundled as Wrangler bundles core, in a directory of its own. */
const bundle = (): string => {
  const dir = tempDir();
  const config = path.join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "model-files-test",
      main: path.join(
        import.meta.dirname,
        "../apps/core/test/on-prem-model-files-worker.ts"
      ),
      compatibility_date: "2026-09-15",
      compatibility_flags: ["nodejs_compat"],
    })
  );
  execFileSync(
    "wrangler",
    ["deploy", "--dry-run", "--outdir", path.join(dir, "bundle"), "-c", config],
    { cwd: dir, stdio: "ignore" }
  );
  return path.join(dir, "bundle");
};

const answerSchema = z.union([
  z.object({ ok: z.unknown() }),
  z.object({ error: z.string() }),
]);

/** A workerd serving the test Worker on the on-prem services, over `release`. */
const serve = async (release: string) => {
  const out = bundle();
  // Wrangler names the bundle after its entry.
  const main = readdirSync(out).find((file) => file.endsWith(".js"));
  writeR2Service(out);
  const files = path.join(tempDir(), "files");
  mkdirSync(files);
  const storage = storageDir();
  const { url } = await serveOnWorkerd(
    out,
    (address) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "test", worker = (
      modules = [(name = "${main}", esModule = embed "${main}"), ${bundledModules(out).join(", ")}],
      compatibilityDate = "2026-09-15",
      compatibilityFlags = ["nodejs_compat"],
      bindings = [
        ${r2Bindings(["MODEL_FILES"]).join(", ")},
        ${modelSourceBinding},
        (name = "EMBEDDER", durableObjectNamespace = (className = "FixtureEmbedder")),
      ],
      durableObjectNamespaces = [
        (className = "FixtureEmbedder", uniqueKey = "FixtureEmbedder", enableSql = true),
      ],
      durableObjectStorage = (localDisk = "storage"),
    )),
    (name = "storage", disk = (path = "${storage}", writable = true)),
    ${r2Services("storage", files).join(",\n    ")},
    ${modelSourceService(release)},
  ],
  sockets = [(name = "http", address = "${address}", http = (), service = "test")],
);
`
  );
  return async (step: string) => {
    const response = await fetch(url, { method: "POST", body: step });
    return answerSchema.parse(await response.json());
  };
};

const deployedKeys = modelFiles
  .map((name) => `embed-models/${sha256Of(name)}`)
  .toSorted();

describe("the on-prem profile's model files", () => {
  afterEach(() => {
    cleanUp();
  });

  it("copies the release's model files into the file-backed bucket and embeds from them on plain workerd", async () => {
    const run = await serve(releaseDir());

    const before = await run("holds");
    const ensured = await run("ensure");
    const embedded = await run("embed");

    expect({ before, ensured, embedded }).toStrictEqual({
      before: { ok: false },
      ensured: { ok: deployedKeys },
      embedded: { ok: { length: 128, model: "fixture-int8" } },
    });
  }, 120_000);

  it("removes the model files no release that runs names", async () => {
    const run = await serve(releaseDir());
    await run("plant");

    const ensured = await run("ensure");

    expect(ensured).toStrictEqual({ ok: deployedKeys });
  }, 120_000);

  it("keeps nothing of a file in the release directory that isn't the release's, and embeds nothing", async () => {
    const release = releaseDir();
    const tokens = path.join(
      release,
      modelBlobKey(sha256Of("tokens-int8.bin"))
    );
    // Other bytes of the same size, under the release's hash.
    const size = readFileSync(tokens).byteLength;
    writeFileSync(tokens, Buffer.alloc(size, 7));
    const run = await serve(release);

    const ensured = await run("ensure");
    const holds = await run("holds");
    const embedded = await run("embed");

    expect(ensured).toHaveProperty("error");
    expect(holds).toStrictEqual({ ok: false });
    expect(answerSchema.parse(embedded)).toStrictEqual({
      error: `fixture-int8's tokens file is missing: no embed-models/${sha256Of("tokens-int8.bin")} in the model files bucket.`,
    });
  }, 120_000);
});
