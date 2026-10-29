/**
 * Promoting a release as the Promote release workflow does: published to
 * staging's bucket by upload-release.ts, fetched back by
 * download-release.ts, then published to production's by upload-release.ts
 * again. Against a stand-in for R2's S3 API (the outside system) holding
 * each bucket's objects in memory.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { buffer, text } from "node:stream/consumers";

import {
  limitEvidenceFile,
  limitEvidenceKey,
  manifestKey,
} from "@grasp-os/shared/release";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { limitEvidenceFor } from "./evidence-lib.ts";
import { builds, info } from "./fixture-release.ts";
import { generateManifest, writeRelease } from "./manifest-lib.ts";

const STAGING = "grasp-releases-staging";
const PRODUCTION = "grasp-releases";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_PRECONDITION_FAILED = 412;

const fixture = await builds();
const manifest = generateManifest(info, fixture);

/** Runs a script in Node, resolving with its stdout; failing with its stderr. */
const run = async (args: string[], env: NodeJS.ProcessEnv): Promise<string> => {
  const child = spawn("node", args, { env });
  const closed = once(child, "close");
  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
  ]);
  await closed;
  if (child.exitCode !== 0) {
    throw new Error(stderr);
  }
  return stdout;
};

const script = (name: string): string => path.join(import.meta.dirname, name);

const sha256 = (bytes: Buffer | undefined): string | undefined =>
  bytes === undefined
    ? undefined
    : createHash("sha256").update(bytes).digest("hex");

/** Each bucket's objects, by key. */
type Buckets = Map<string, Map<string, Buffer>>;

describe("promoting a release from staging's bucket to production's", () => {
  let dir = "";
  let server: Server | undefined;
  let buckets: Buckets = new Map();
  let endpoint = "";

  const envFor = (bucket: string): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    R2_ENDPOINT: endpoint,
    R2_BUCKET: bucket,
    R2_ACCESS_KEY_ID: "test-key-id",
    R2_SECRET_ACCESS_KEY: "test-secret",
  });

  const upload = async (bucket: string, release: string): Promise<string> =>
    await run(
      [script("upload-release.ts"), "--release", release],
      envFor(bucket)
    );

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-promote-test-"));
    const built = path.join(dir, "built");
    writeRelease(built, manifest, fixture);
    writeFileSync(
      path.join(built, limitEvidenceFile),
      `${JSON.stringify(limitEvidenceFor(manifest, null))}\n`
    );
    buckets = new Map([
      [STAGING, new Map()],
      [PRODUCTION, new Map()],
    ]);
    const current = buckets;
    server = createServer((request, response) => {
      void (async () => {
        const [, bucketName = "", ...rest] = (request.url ?? "").split("/");
        const objects = current.get(bucketName);
        const key = rest.join("/");
        if (
          objects === undefined ||
          request.headers.authorization === undefined
        ) {
          response.writeHead(HTTP_NOT_FOUND).end();
          return;
        }
        const stored = objects.get(key);
        if (request.method === "HEAD" || request.method === "GET") {
          response.writeHead(stored === undefined ? HTTP_NOT_FOUND : HTTP_OK);
          response.end(request.method === "GET" ? stored : undefined);
          return;
        }
        const body = await buffer(request);
        if (request.headers["if-none-match"] === "*" && stored !== undefined) {
          response.writeHead(HTTP_PRECONDITION_FAILED).end();
          return;
        }
        objects.set(key, body);
        response.writeHead(HTTP_OK).end();
      })();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port for the stand-in");
    }
    endpoint = `http://127.0.0.1:${address.port}`;
    await upload(STAGING, built);
  });

  afterEach(async () => {
    server?.close();
    if (server) {
      await once(server, "close");
    }
    rmSync(dir, { force: true, recursive: true });
  });

  const download = async (out: string, releaseId = manifest.releaseId) =>
    await run(
      [script("download-release.ts"), "--release", releaseId, "--out", out],
      envFor(STAGING)
    );

  const promote = async (releaseId = manifest.releaseId): Promise<void> => {
    const fetched = path.join(dir, "fetched");
    await download(fetched, releaseId);
    await upload(PRODUCTION, fetched);
  };

  const contents = (bucket: string): Record<string, string | undefined> =>
    Object.fromEntries(
      [...(buckets.get(bucket) ?? new Map<string, Buffer>())].map(
        ([key, bytes]) => [key, sha256(bytes)]
      )
    );

  it("publishes to production exactly what staging holds: every blob, the limit evidence and the manifest", async () => {
    await promote();
    expect(contents(PRODUCTION)).toStrictEqual(contents(STAGING));
    expect(Object.keys(contents(PRODUCTION))).toStrictEqual(
      expect.arrayContaining([
        manifestKey(manifest.releaseId),
        limitEvidenceKey(manifest.releaseId),
      ])
    );
  });

  it("leaves a non-empty directory that isn't a release untouched, and replaces one it downloaded before", async () => {
    const unrelated = path.join(dir, "notes");
    mkdirSync(unrelated);
    writeFileSync(path.join(unrelated, "keep.txt"), "mine");
    const again = path.join(dir, "again");
    await download(again);
    await download(again);

    await expect(download(unrelated)).rejects.toThrow(
      /isn't a release directory/u
    );
    expect({
      files: readdirSync(unrelated),
      kept: readFileSync(path.join(unrelated, "keep.txt"), "utf-8"),
      replaced: readdirSync(again).includes("manifest.json"),
    }).toStrictEqual({ files: ["keep.txt"], kept: "mine", replaced: true });
  });

  it("publishes nothing for a release staging doesn't hold", async () => {
    await expect(promote("r999999-fffffff")).rejects.toThrow(
      /isn't published in grasp-releases-staging/u
    );
    expect(buckets.get(PRODUCTION)?.size).toBe(0);
  });

  it("publishes nothing when a blob in staging's bucket isn't the release's", async () => {
    const module = manifest.workers.core?.modules[0];
    if (module === undefined) {
      throw new Error("expected a core module");
    }
    buckets.get(STAGING)?.set(module.r2Key, Buffer.from("tampered"));
    await expect(promote()).rejects.toThrow(/doesn't match its hash/u);
    expect(buckets.get(PRODUCTION)?.size).toBe(0);
  });

  it("publishes nothing when staging holds the release without its limit evidence", async () => {
    buckets.get(STAGING)?.delete(limitEvidenceKey(manifest.releaseId));
    await expect(promote()).rejects.toThrow(/has no limit-evidence.json/u);
    expect(buckets.get(PRODUCTION)?.size).toBe(0);
  });
});
