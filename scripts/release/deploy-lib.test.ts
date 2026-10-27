/**
 * A release laid out for Wrangler to deploy (deploy-lib.ts), from a
 * release written from the real wrangler.jsonc of core and connect with
 * fixture builds (fixture-release.ts).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { moduleKey } from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  assertUploadMatches,
  deployConfig,
  layOutWorker,
} from "./deploy-lib.ts";
import { builds, info } from "./fixture-release.ts";
import { collectModules } from "./hash-lib.ts";
import { generateManifest, writeRelease } from "./manifest-lib.ts";

const fixture = await builds();
const manifest = generateManifest(info, fixture);
const { core } = manifest.workers;
const [coreModule] = core?.modules ?? [];
if (core === undefined || coreModule === undefined) {
  throw new Error("expected core with a module");
}

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(file, "utf-8"));

describe("a release laid out for Wrangler", () => {
  let release = "";
  let work = "";
  let out = "";

  beforeEach(() => {
    release = mkdtempSync(path.join(tmpdir(), "grasp-os-deploy-release-"));
    work = mkdtempSync(path.join(tmpdir(), "grasp-os-deploy-test-"));
    out = path.join(work, "core");
    writeRelease(release, manifest, fixture);
  });

  afterEach(() => {
    rmSync(release, { force: true, recursive: true });
    rmSync(work, { force: true, recursive: true });
  });

  /** Rewrites the release's manifest.json through `change`. */
  const editManifest = (change: (edited: ReleaseManifest) => void): void => {
    const edited = structuredClone(manifest);
    change(edited);
    writeFileSync(path.join(release, "manifest.json"), JSON.stringify(edited));
  };

  it("writes every file the manifest names, with the bytes it hashes to", async () => {
    const { config } = await layOutWorker(release, "core", out);
    for (const module of core.modules) {
      expect(sha256(readFileSync(path.join(out, "worker", module.name)))).toBe(
        module.sha256
      );
    }
    for (const database of core.d1Databases) {
      for (const migration of database.migrations) {
        const file = path.join(out, "migrations", database.binding);
        expect(sha256(readFileSync(path.join(file, migration.name)))).toBe(
          migration.sha256
        );
      }
    }
    for (const [assetPath, { size }] of Object.entries(
      core.assets?.manifest ?? {}
    )) {
      expect(readFileSync(path.join(out, "assets", assetPath))).toHaveLength(
        size
      );
    }
    const laidOut = await collectModules(path.join(out, "worker"));
    expect(() => {
      assertUploadMatches(core, laidOut);
    }).not.toThrow();
    expect(readJson(config)).toMatchObject({
      name: "grasp-os-core",
      main: `worker/${core.mainModule}`,
      no_bundle: true,
      compatibility_date: manifest.compatibilityDate,
      d1_databases: [
        { binding: "DB", database_name: "grasp-os-core" },
        { binding: "BRAIN_DB", database_name: "grasp-os-knowledge" },
      ],
      services: [{ binding: "CONNECT", service: "grasp-os-connect" }],
      assets: { directory: "assets", binding: "ASSETS" },
    });
  });

  it("refuses a corrupted file before laying anything out", async () => {
    writeFileSync(path.join(release, moduleKey(coreModule.sha256)), "tampered");
    await expect(layOutWorker(release, "core", out)).rejects.toThrow(
      /doesn't match its hash/u
    );
    expect(existsSync(out)).toBeFalsy();
  });

  it("refuses a file the manifest names outside the layout", async () => {
    editManifest((edited) => {
      const [module] = edited.workers.core?.modules ?? [];
      if (module !== undefined) {
        module.name = "../escaped.js";
      }
    });
    await expect(layOutWorker(release, "core", out)).rejects.toThrow(
      /isn't a plain path/u
    );
    expect(existsSync(path.join(out, "escaped.js"))).toBeFalsy();
  });

  it("refuses a Worker the release doesn't have", async () => {
    await expect(layOutWorker(release, "router", out)).rejects.toThrow(
      /has no Worker router/u
    );
  });

  it("refuses a binding it can't give Wrangler as the manifest has it", () => {
    const withBinding = (
      binding: { type: string } & Record<string, unknown>
    ): typeof core => ({
      ...core,
      bindings: [...core.bindings, { name: "EXTRA", ...binding }],
    });
    expect(() =>
      deployConfig(manifest, withBinding({ type: "hyperdrive", id: "x" }))
    ).toThrow(/hyperdrive/u);
    expect(() =>
      deployConfig(manifest, withBinding({ type: "d1", id: "real-id" }))
    ).toThrow(/isn't one of its databases/u);
  });

  it("refuses an upload that isn't the release's modules", async () => {
    const tampered = path.join(work, "tampered");
    await layOutWorker(release, "core", tampered);
    writeFileSync(path.join(tampered, "worker", coreModule.name), "tampered");
    const uploaded = await collectModules(path.join(tampered, "worker"));
    expect(() => {
      assertUploadMatches(core, uploaded);
    }).toThrow(`${coreModule.name} ${coreModule.type} ${coreModule.sha256}`);
  });
});
