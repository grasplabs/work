/**
 * upload-release.ts run as CI runs it, against a stand-in for R2's S3 API
 * (the outside system) that stores objects in memory and, as R2 does,
 * honours `If-None-Match: *`, checks `x-amz-checksum-sha256` on a PUT and
 * reports it on a HEAD with checksum mode on.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { buffer, text } from "node:stream/consumers";

import {
  commitKey,
  limitEvidenceFile,
  limitEvidenceKey,
  moduleKey,
} from "@grasp-os/shared/release";
import {
  compareReleaseIds,
  releaseMonthPrefix,
} from "@grasp-os/shared/release-id";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { limitEvidenceFor } from "./evidence-lib.ts";
import { builds, info } from "./fixture-release.ts";
import { generateManifest, writeRelease } from "./manifest-lib.ts";

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
const SCRIPT = path.join(import.meta.dirname, "upload-release.ts");

/** How a run ended: "ok", or what it said on its way out. */
const outcomeOf = async (running: Promise<unknown>): Promise<string> => {
  try {
    await running;
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const BUCKET = "grasp-releases-staging";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_PRECONDITION_FAILED = 412;

const fixture = await builds();
const manifest = generateManifest(info, fixture);
const published = `releases/${manifest.releaseId}/manifest.json`;

const HTTP_BAD_REQUEST = 400;

/** What the tests read of a published manifest and its evidence. */
const storedManifest = z.object({ releaseId: z.string(), commit: z.string() });
const storedEvidence = z.object({
  releaseId: z.string(),
  limitEvidence: z.array(z.object({ releaseId: z.string() })),
});

const sha256Base64 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64");

/**
 * Objects by key, the SHA-256 each was stored with (if any), every PUT that
 * stored one, in order, and objects another writer stores (without a
 * checksum) right after answering a HEAD for their key with "not found".
 */
interface Bucket {
  objects: Map<string, Buffer>;
  checksums: Map<string, string>;
  puts: string[];
  writtenAfterHead: Map<string, Buffer>;
  /** Objects another writer stores right after the next listing is answered. */
  writtenAfterList: Map<string, Buffer>;
  /** Keys whose next PUT is refused, as R2 failing a write for good (a 5xx is retried). */
  failingPuts: Set<string>;
}

const emptyBucket = (): Bucket => ({
  objects: new Map(),
  checksums: new Map(),
  puts: [],
  writtenAfterHead: new Map(),
  writtenAfterList: new Map(),
  failingPuts: new Set(),
});

/** A ListObjectsV2 by `/` of the keys under `prefix`, in one page. */
const listing = (bucket: Bucket, prefix: string): string => {
  const ids = new Set(
    [...bucket.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(0, key.indexOf("/", "releases/".length) + 1))
      .filter((key) => key.length > 0)
  );
  return `<ListBucketResult><IsTruncated>false</IsTruncated>${[...ids]
    .map((id) => `<CommonPrefixes><Prefix>${id}</Prefix></CommonPrefixes>`)
    .join("")}</ListBucketResult>`;
};

/** Answers a ListObjectsV2 of the bucket, if `request` is one. */
const answeredListing = (
  bucket: Bucket,
  request: IncomingMessage,
  response: ServerResponse
): boolean => {
  const url = request.url ?? "";
  if (
    !url.startsWith(`/${BUCKET}?`) ||
    request.method !== "GET" ||
    request.headers.authorization === undefined
  ) {
    return false;
  }
  const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  response.writeHead(HTTP_OK).end(listing(bucket, query.get("prefix") ?? ""));
  for (const [key, bytes] of bucket.writtenAfterList) {
    bucket.objects.set(key, bytes);
  }
  bucket.writtenAfterList.clear();
  return true;
};

const handle = async (
  bucket: Bucket,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const prefix = `/${BUCKET}/`;
  const url = request.url ?? "";
  if (answeredListing(bucket, request, response)) {
    return;
  }
  const key = url.startsWith(prefix) ? url.slice(prefix.length) : undefined;
  if (key === undefined || request.headers.authorization === undefined) {
    response.writeHead(HTTP_NOT_FOUND).end();
    return;
  }
  const stored = bucket.objects.get(key);
  if (request.method === "HEAD") {
    const checksum = bucket.checksums.get(key);
    const reportChecksum =
      checksum !== undefined &&
      request.headers["x-amz-checksum-mode"] === "ENABLED";
    response
      .writeHead(
        stored === undefined ? HTTP_NOT_FOUND : HTTP_OK,
        reportChecksum ? { "x-amz-checksum-sha256": checksum } : {}
      )
      .end();
    const other = bucket.writtenAfterHead.get(key);
    if (other !== undefined && stored === undefined) {
      bucket.objects.set(key, other);
    }
    return;
  }
  if (request.method === "GET") {
    response.writeHead(stored === undefined ? HTTP_NOT_FOUND : HTTP_OK);
    response.end(stored);
    return;
  }
  const body = await buffer(request);
  if (bucket.failingPuts.delete(key)) {
    response.writeHead(HTTP_BAD_REQUEST).end();
    return;
  }
  if (request.headers["if-none-match"] === "*" && stored !== undefined) {
    response.writeHead(HTTP_PRECONDITION_FAILED).end();
    return;
  }
  const checksum = request.headers["x-amz-checksum-sha256"];
  if (typeof checksum === "string" && checksum !== sha256Base64(body)) {
    response.writeHead(HTTP_BAD_REQUEST).end();
    return;
  }
  bucket.objects.set(key, body);
  if (typeof checksum === "string") {
    bucket.checksums.set(key, checksum);
  }
  bucket.puts.push(key);
  response.writeHead(HTTP_OK).end();
};

describe("publishing a release", () => {
  let dir = "";
  let server: Server | undefined;
  let bucket = emptyBucket();
  let endpoint = "";
  /** Release directories `buildOf` made, removed after each test. */
  const builtDirs: string[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-upload-test-"));
    writeRelease(dir, manifest, fixture);
    writeFileSync(
      path.join(dir, limitEvidenceFile),
      `${JSON.stringify(limitEvidenceFor(manifest, null))}\n`
    );
    bucket = emptyBucket();
    const current = bucket;
    server = createServer((request, response) => {
      void handle(current, request, response);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port for the stand-in");
    }
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server?.close();
    if (server) {
      await once(server, "close");
    }
    rmSync(dir, { force: true, recursive: true });
    for (const built of builtDirs.splice(0)) {
      rmSync(built, { force: true, recursive: true });
    }
  });

  const upload = async (...flags: string[]): Promise<string> =>
    await run([SCRIPT, "--release", dir, ...flags], {
      PATH: process.env.PATH,
      R2_ENDPOINT: endpoint,
      R2_BUCKET: BUCKET,
      R2_ACCESS_KEY_ID: "test-key-id",
      R2_SECRET_ACCESS_KEY: "test-secret",
    });

  it("uploads every blob, then the limit evidence with its SHA-256, then the manifest last", async () => {
    await upload();
    const referenced = [
      ...Object.values(manifest.workers).flatMap((worker) => [
        ...worker.modules.map((module) => module.r2Key),
        ...worker.d1Databases.flatMap((database) =>
          database.migrations.map((migration) => migration.r2Key)
        ),
      ]),
      ...Object.values(manifest.assets).map((asset) => asset.r2Key),
    ];
    const evidence = limitEvidenceKey(manifest.releaseId);
    expect(bucket.puts.slice(-2)).toStrictEqual([evidence, published]);
    expect(bucket.checksums.get(evidence)).toBe(
      sha256Base64(readFileSync(path.join(dir, limitEvidenceFile)))
    );
    expect(bucket.puts.slice(0, -2).toSorted()).toStrictEqual(
      [...new Set(referenced)].toSorted()
    );
  });

  it("publishes nothing without the release's own limit evidence, or with evidence for a raise it lacks", async () => {
    const evidenceFile = path.join(dir, limitEvidenceFile);
    rmSync(evidenceFile);
    const missing = await outcomeOf(upload());
    writeFileSync(
      evidenceFile,
      JSON.stringify({
        ...limitEvidenceFor(manifest, null),
        releaseId: "26.01.999999",
      })
    );
    const another = await outcomeOf(upload());
    // The release before had fewer workflow steps: a raise, with no evidence.
    writeFileSync(
      evidenceFile,
      JSON.stringify({
        ...limitEvidenceFor(manifest, null),
        previousRelease: {
          releaseId: "25.12.1",
          platformLimits: { ...info.platformLimits, workflowSteps: 10 },
        },
      })
    );
    const unevidenced = await outcomeOf(upload());

    expect({
      missing: missing.includes("has no limit-evidence.json"),
      another: another.includes("is for 26.01.999999"),
      unevidenced: unevidenced.includes(
        "raises workflowSteps to 1000 without capacity and security evidence"
      ),
      published: bucket.objects.has(published),
    }).toStrictEqual({
      missing: true,
      another: true,
      unevidenced: true,
      published: false,
    });
  });

  it("skips blobs R2 has, and never replaces a published manifest", async () => {
    await upload();
    const first = bucket.objects.get(published);
    bucket.puts.length = 0;
    writeFileSync(
      path.join(dir, "manifest.json"),
      `${JSON.stringify({ ...manifest, createdAt: "2026-02-02T00:00:00.000Z" })}\n`
    );
    const stdout = await upload();
    expect(bucket.puts).toStrictEqual([]);
    expect(bucket.objects.get(published)).toStrictEqual(first);
    expect(stdout).toContain("0 uploaded");
  });

  const coreModule = (): { key: string; bytes: Buffer } => {
    const module = manifest.workers.core?.modules[0];
    if (module === undefined) {
      throw new Error("expected a core module");
    }
    return {
      key: module.r2Key,
      bytes: readFileSync(path.join(dir, module.r2Key)),
    };
  };

  it("keeps a matching blob another writer stores between its HEAD and its PUT", async () => {
    const { key, bytes } = coreModule();
    bucket.writtenAfterHead.set(key, bytes);
    const stdout = await upload();
    expect(bucket.puts).not.toContain(key);
    expect(bucket.puts.at(-1)).toBe(published);
    expect(stdout).toContain(`Published ${published}`);
  });

  it("publishes nothing when another writer stores other bytes between its HEAD and its PUT", async () => {
    const { key } = coreModule();
    bucket.writtenAfterHead.set(key, Buffer.from("other bytes"));
    await expect(upload()).rejects.toThrow(/isn't the release's bytes/u);
    expect(bucket.objects.has(published)).toBeFalsy();
  });

  it("publishes nothing when R2 already holds other bytes at a blob's key", async () => {
    const { key } = coreModule();
    const other = Buffer.from("other bytes");
    bucket.objects.set(key, other);
    bucket.checksums.set(key, sha256Base64(other));
    await expect(upload()).rejects.toThrow(/isn't the release's bytes/u);
    expect(bucket.objects.has(published)).toBeFalsy();
  });

  it("uploads only the blobs the manifest references", async () => {
    const stray = "blobs/modules/stray";
    mkdirSync(path.dirname(path.join(dir, stray)), { recursive: true });
    writeFileSync(path.join(dir, stray), "not in the manifest");
    await upload();
    expect(bucket.puts).not.toContain(stray);
  });

  it("keeps the id it has without --assign-id, as Promote release publishes it", async () => {
    await upload();
    expect(bucket.objects.get(published)).toStrictEqual(
      readFileSync(path.join(dir, "manifest.json"))
    );
  });

  /** A built release of `commit` in a directory of its own, under a build's id. */
  const buildOf = (commit: string): string => {
    const built = mkdtempSync(path.join(tmpdir(), "grasp-os-upload-test-"));
    const local = generateManifest(
      { ...info, releaseId: "dev-build", commit },
      fixture
    );
    writeRelease(built, local, fixture);
    writeFileSync(
      path.join(built, limitEvidenceFile),
      `${JSON.stringify(limitEvidenceFor(local, null))}\n`
    );
    builtDirs.push(built);
    return built;
  };

  const publish = async (built: string): Promise<string> =>
    await run([SCRIPT, "--release", built, "--assign-id"], {
      PATH: process.env.PATH,
      R2_ENDPOINT: endpoint,
      R2_BUCKET: BUCKET,
      R2_ACCESS_KEY_ID: "test-key-id",
      R2_SECRET_ACCESS_KEY: "test-secret",
    });

  /** The ids published, oldest first, each with its manifest's and evidence's ids and commit. */
  const publishedReleases = (): {
    id: string;
    manifestId: unknown;
    evidenceIds: unknown[];
    commit: unknown;
  }[] =>
    [...bucket.objects.keys()]
      .filter((key) => key.endsWith("/manifest.json"))
      .map((key) => key.slice("releases/".length, -"/manifest.json".length))
      .toSorted(compareReleaseIds)
      .map((id) => {
        const stored = storedManifest.parse(
          JSON.parse(
            bucket.objects.get(`releases/${id}/manifest.json`)?.toString() ?? ""
          )
        );
        const evidence = storedEvidence.parse(
          JSON.parse(bucket.objects.get(limitEvidenceKey(id))?.toString() ?? "")
        );
        return {
          id,
          manifestId: stored.releaseId,
          evidenceIds: [
            evidence.releaseId,
            ...evidence.limitEvidence.map((entry) => entry.releaseId),
          ],
          commit: stored.commit,
        };
      });

  it("publishes under the month's next id, YY.MM.N, the next commit under the one after", async () => {
    const month = releaseMonthPrefix(new Date());
    await publish(buildOf("1".repeat(40)));
    await publish(buildOf("2".repeat(40)));

    expect(publishedReleases()).toStrictEqual([
      {
        id: `${month}1`,
        manifestId: `${month}1`,
        evidenceIds: [`${month}1`],
        commit: "1".repeat(40),
      },
      {
        id: `${month}2`,
        manifestId: `${month}2`,
        evidenceIds: [`${month}2`],
        commit: "2".repeat(40),
      },
    ]);
    expect(bucket.objects.get(commitKey("2".repeat(40)))?.toString()).toBe(
      `${month}2\n`
    );
  });

  it("takes the next id when another publish claims one between its listing and its write", async () => {
    const month = releaseMonthPrefix(new Date());
    bucket.writtenAfterList.set(
      limitEvidenceKey(`${month}1`),
      Buffer.from("another publish's")
    );
    await publish(buildOf("1".repeat(40)));

    expect(bucket.objects.get(limitEvidenceKey(`${month}1`))?.toString()).toBe(
      "another publish's"
    );
    expect(publishedReleases().map(({ id }) => id)).toStrictEqual([
      `${month}2`,
    ]);
  });

  it("never gives publishes running at once the same id", async () => {
    const commits = ["3", "4", "5"].map((digit) => digit.repeat(40));
    const dirs = commits.map(buildOf);
    await Promise.all(dirs.map(publish));

    const releases = publishedReleases();
    expect(new Set(releases.map(({ id }) => id)).size).toBe(commits.length);
    expect(
      releases
        .map(({ commit }) => String(commit))
        .toSorted((a, b) => a.localeCompare(b))
    ).toStrictEqual(commits);
    expect(
      releases.every(
        ({ id, manifestId, evidenceIds }) =>
          manifestId === id && evidenceIds.every((other) => other === id)
      )
    ).toBeTruthy();
  });

  it("publishes a commit once, however often its publish runs", async () => {
    await publish(buildOf("6".repeat(40)));
    const stdout = await publish(buildOf("6".repeat(40)));

    expect(publishedReleases()).toHaveLength(1);
    expect(stdout).not.toContain("Published");
  });

  it("marks, rather than publishes again, a commit whose publish stopped between its manifest and its marker", async () => {
    const month = releaseMonthPrefix(new Date());
    const commit = "7".repeat(40);
    bucket.failingPuts.add(commitKey(commit));
    const stopped = await outcomeOf(publish(buildOf(commit)));
    const rerun = await publish(buildOf(commit));

    expect({
      stopped: stopped.includes(`PUT ${commitKey(commit)}: 400`),
      releases: publishedReleases().map(({ id }) => id),
      marker: bucket.objects.get(commitKey(commit))?.toString(),
      published: rerun.includes("Published"),
    }).toStrictEqual({
      stopped: true,
      releases: [`${month}1`],
      marker: `${month}1\n`,
      published: false,
    });
  });

  it("uploads nothing on a dry run", async () => {
    const stdout = await upload("--dry-run");
    expect(bucket.puts).toStrictEqual([]);
    expect(stdout).toContain(published);
  });

  it("uploads nothing from a release that doesn't verify", async () => {
    const module = manifest.workers.core?.modules[0];
    if (module === undefined) {
      throw new Error("expected a core module");
    }
    writeFileSync(path.join(dir, moduleKey(module.sha256)), "tampered");
    await expect(upload()).rejects.toThrow(/doesn't match its hash/u);
    expect(bucket.puts).toStrictEqual([]);
  });
});
