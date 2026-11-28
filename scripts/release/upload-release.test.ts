/**
 * upload-release.ts run as Promote release runs it, against a stand-in
 * for R2's S3 API
 * (the outside system) that stores objects in memory and, as R2 does,
 * honours `If-None-Match: *` and `If-Match` on an object's ETag (its
 * bytes' MD5, as for a single-part PUT), checks `x-amz-checksum-sha256` on
 * a PUT and reports it on a HEAD with checksum mode on, and, as a bucket
 * lock on `releases/` and `signatures/` does, answers a write to a key
 * there that holds something with 409. It can fail a request as a
 * network does: drop the connection unanswered, or answer 500, before or
 * after doing what was asked.
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

import { modelBlobKey, moduleKey } from "@grasp-os/shared/release";
import {
  RELEASE_SIGNATURE_FILE,
  releaseSignatureProblem,
  signatureKey,
} from "@grasp-os/shared/release-signature";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  releaseSigningKeys,
  signReleaseManifest,
  testReleaseSigningKey,
} from "../../packages/shared/test/release-signing-keys.ts";
import { builds, fixtureModelFiles, info } from "./fixture-release.ts";
import { generateManifest, writeRelease } from "./manifest-lib.ts";

const TRUST_TEST_KEY = path.join(import.meta.dirname, "trust-test-key.ts");

/**
 * Runs a script in Node, trusting the tests' signing key
 * (trust-test-key.ts), resolving with its stdout; failing with its stderr.
 */
const run = async (args: string[], env: NodeJS.ProcessEnv): Promise<string> => {
  const child = spawn("node", ["--import", TRUST_TEST_KEY, ...args], { env });
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
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;

const sha256Base64 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64");

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** An object's ETag as R2 gives one for a single-part PUT: its bytes' MD5, quoted. */
const etagOf = (bytes: Uint8Array): string =>
  `"${createHash("md5").update(bytes).digest("hex")}"`;

/**
 * How the stand-in fails one request for a key instead of answering it:
 * `drop` closes the connection unanswered, as a reset does; `500` answers
 * 500; `cut` sends the answer's headers and half its body, then closes
 * the connection (`after` implied). `after` does what was asked first (a
 * PUT stores), so only the answer is lost. `meanwhile` runs before the
 * failure: another writer. `method`, when set, is the only method it
 * meets; it waits for that one.
 */
interface Fault {
  answer: "drop" | "500" | "cut";
  method?: string;
  after?: boolean;
  meanwhile?: () => void;
}

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
  /** Keys whose next PUT is refused, as R2 failing a write for good (a 5xx is retried). */
  failingPuts: Set<string>;
  /** The failures each key's next requests meet, in turn, whatever their method. */
  faults: Map<string, Fault[]>;
  /** Every request answered or failed, as `<method> <key>`. */
  requests: string[];
  /** Whether `releases/` and `signatures/` are locked, as production's buckets are. */
  locked: boolean;
}

const emptyBucket = (): Bucket => ({
  objects: new Map(),
  checksums: new Map(),
  puts: [],
  writtenAfterHead: new Map(),
  failingPuts: new Set(),
  faults: new Map(),
  requests: [],
  locked: true,
});

/**
 * A bucket holding the fixture model's files, as upload-model-files.ts
 * leaves them: each at its content address, stored with its SHA-256.
 */
const bucketWithModel = (): Bucket => {
  const bucket = emptyBucket();
  for (const { sha256, file } of fixtureModelFiles) {
    const bytes = readFileSync(file);
    bucket.objects.set(modelBlobKey(sha256), bytes);
    bucket.checksums.set(modelBlobKey(sha256), sha256Base64(bytes));
  }
  return bucket;
};

/**
 * A HEAD's headers, as R2 answers one: the object's length, and the
 * SHA-256 it was stored with when checksum mode asks.
 */
const headHeaders = (
  bucket: Bucket,
  key: string,
  request: IncomingMessage,
  stored: Buffer | undefined
): Record<string, string | number> => {
  const checksum = bucket.checksums.get(key);
  return {
    ...(stored === undefined
      ? {}
      : { "content-length": stored.byteLength, etag: etagOf(stored) }),
    ...(checksum !== undefined &&
    request.headers["x-amz-checksum-mode"] === "ENABLED"
      ? { "x-amz-checksum-sha256": checksum }
      : {}),
  };
};

/** An answer the stand-in sends, unless a fault loses it. */
interface Answer {
  status: number;
  headers?: Record<string, string | number>;
  body?: Buffer;
}

/** Does what `request` asks of `key`, as R2 does: its answer. */
const serveObject = async (
  bucket: Bucket,
  key: string,
  request: IncomingMessage
): Promise<Answer> => {
  const stored = bucket.objects.get(key);
  if (request.method === "HEAD") {
    const other = bucket.writtenAfterHead.get(key);
    if (other !== undefined && stored === undefined) {
      bucket.objects.set(key, other);
    }
    return {
      status: stored === undefined ? HTTP_NOT_FOUND : HTTP_OK,
      headers: headHeaders(bucket, key, request, stored),
    };
  }
  if (request.method === "GET") {
    return stored === undefined
      ? { status: HTTP_NOT_FOUND }
      : { status: HTTP_OK, headers: { etag: etagOf(stored) }, body: stored };
  }
  const body = await buffer(request);
  if (bucket.failingPuts.delete(key)) {
    return { status: HTTP_BAD_REQUEST };
  }
  if (
    bucket.locked &&
    stored !== undefined &&
    (key.startsWith("releases/") || key.startsWith("signatures/"))
  ) {
    // The lock is checked first, whatever the request's conditions.
    return { status: HTTP_CONFLICT };
  }
  const ifMatch = request.headers["if-match"];
  if (
    (request.headers["if-none-match"] === "*" && stored !== undefined) ||
    (ifMatch !== undefined &&
      (stored === undefined || ifMatch !== etagOf(stored)))
  ) {
    return { status: HTTP_PRECONDITION_FAILED };
  }
  const checksum = request.headers["x-amz-checksum-sha256"];
  if (typeof checksum === "string" && checksum !== sha256Base64(body)) {
    return { status: HTTP_BAD_REQUEST };
  }
  bucket.objects.set(key, body);
  if (typeof checksum === "string") {
    bucket.checksums.set(key, checksum);
  }
  bucket.puts.push(key);
  return { status: HTTP_OK, headers: { etag: etagOf(body) } };
};

/** Sends `answer`, or fails it as `fault` says. */
const send = (
  response: ServerResponse,
  answer: Answer | undefined,
  fault: Fault | undefined
): void => {
  if (fault?.answer === "drop") {
    response.socket?.destroy();
  } else if (fault?.answer === "500") {
    response.writeHead(HTTP_SERVER_ERROR).end();
  } else if (fault?.answer === "cut" && answer?.body !== undefined) {
    const { body } = answer;
    response.writeHead(answer.status, {
      ...answer.headers,
      "content-length": body.byteLength,
    });
    response.write(body.subarray(0, body.byteLength / 2), () => {
      response.socket?.destroy();
    });
  } else if (answer !== undefined) {
    response.writeHead(answer.status, answer.headers).end(answer.body);
  }
};

const handle = async (
  bucket: Bucket,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const prefix = `/${BUCKET}/`;
  const url = request.url ?? "";
  const key = url.startsWith(prefix) ? url.slice(prefix.length) : undefined;
  if (key === undefined || request.headers.authorization === undefined) {
    response.writeHead(HTTP_NOT_FOUND).end();
    return;
  }
  bucket.requests.push(`${request.method ?? ""} ${key}`);
  const [next] = bucket.faults.get(key) ?? [];
  const fault =
    next?.method === undefined || next.method === request.method
      ? bucket.faults.get(key)?.shift()
      : undefined;
  fault?.meanwhile?.();
  const served =
    fault === undefined || fault.after === true || fault.answer === "cut";
  if (!served) {
    await buffer(request);
  }
  const answer = served ? await serveObject(bucket, key, request) : undefined;
  send(response, answer, fault);
};

describe("publishing a release as it has it", () => {
  let dir = "";
  let server: Server | undefined;
  let bucket = emptyBucket();
  let endpoint = "";
  /** Release directories `buildOf` made, removed after each test. */
  const builtDirs: string[] = [];

  /** Serves `stored` as the stand-in's bucket, in place of any served before. */
  const serve = async (stored: Bucket): Promise<void> => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    bucket = stored;
    server = createServer((request, response) => {
      void handle(stored, request, response);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port for the stand-in");
    }
    endpoint = `http://127.0.0.1:${address.port}`;
  };

  /** Signs the release directory's manifest as it is, as Promote release's download leaves one. */
  const signDir = async (): Promise<void> => {
    writeFileSync(
      path.join(dir, RELEASE_SIGNATURE_FILE),
      await signReleaseManifest(
        readFileSync(path.join(dir, "manifest.json")),
        testReleaseSigningKey
      )
    );
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-upload-test-"));
    writeRelease(dir, manifest, fixture);
    await signDir();
    await serve(bucketWithModel());
  });

  afterEach(async () => {
    server?.close();
    if (server) {
      await once(server, "close");
      server = undefined;
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

  /**
   * Why release `id`'s published manifest doesn't verify with the
   * signature stored for it; undefined when it does.
   */
  const signatureProblemOf = async (
    id: string
  ): Promise<string | undefined> => {
    const bytes = bucket.objects.get(`releases/${id}/manifest.json`);
    if (bytes === undefined) {
      return "isn't published";
    }
    return await releaseSignatureProblem(
      bytes,
      bucket.objects.get(signatureKey(sha256Hex(bytes))),
      releaseSigningKeys,
      id
    );
  };

  it("uploads every blob, then the manifest last", async () => {
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
    const signature = signatureKey(
      sha256Hex(readFileSync(path.join(dir, "manifest.json")))
    );
    expect(bucket.puts.slice(-2)).toStrictEqual([signature, published]);
    expect(bucket.puts.slice(0, -2).toSorted()).toStrictEqual(
      [...new Set(referenced)].toSorted()
    );
  });

  it("skips blobs R2 has, and never replaces a published manifest", async () => {
    await upload();
    const first = bucket.objects.get(published);
    bucket.puts.length = 0;
    writeFileSync(
      path.join(dir, "manifest.json"),
      `${JSON.stringify({ ...manifest, createdAt: "2026-02-02T00:00:00.000Z" })}\n`
    );
    await signDir();
    const outcome = await outcomeOf(upload());
    expect({
      refused: outcome.includes("holds another manifest"),
      // No blob, and only its signature, which names the other
      // manifest's bytes.
      puts: bucket.puts,
      stored: bucket.objects.get(published),
    }).toStrictEqual({
      refused: true,
      puts: [
        signatureKey(sha256Hex(readFileSync(path.join(dir, "manifest.json")))),
      ],
      stored: first,
    });
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

  const firstModelFile = (): { name: string; r2Key: string } => {
    const [file] = manifest.modelFiles;
    if (file === undefined) {
      throw new Error("expected a model file");
    }
    return file;
  };

  it("publishes nothing when a model file the release names isn't in the bucket", async () => {
    bucket.objects.delete(firstModelFile().r2Key);
    await expect(upload()).rejects.toThrow(
      /is missing: put it there with release:model-files; nothing published/u
    );
    expect(bucket.puts).toStrictEqual([]);
  });

  it("publishes nothing when the bucket holds other bytes at a model file's key", async () => {
    const { r2Key } = firstModelFile();
    // Other bytes of the same size: the hash gives them away.
    const other = Buffer.alloc(bucket.objects.get(r2Key)?.byteLength ?? 0, 7);
    bucket.objects.set(r2Key, other);
    bucket.checksums.set(r2Key, sha256Base64(other));
    await expect(upload()).rejects.toThrow(
      /doesn't match its hash.*nothing published/u
    );
    expect(bucket.puts).toStrictEqual([]);
  });

  it("publishes nothing when a model file is in the bucket with its bytes but without its SHA-256, which the import asks for", async () => {
    const { r2Key } = firstModelFile();
    bucket.checksums.delete(r2Key);
    await expect(upload()).rejects.toThrow(
      /was stored without its SHA-256: put it there with release:model-files; nothing published/u
    );
    expect(bucket.puts).toStrictEqual([]);
  });

  it("puts a carried model file found without its SHA-256 again with it, then publishes", async () => {
    const { r2Key } = firstModelFile();
    bucket.checksums.delete(r2Key);
    mkdirSync(path.join(dir, "blobs/models"), { recursive: true });
    for (const { sha256, file } of fixtureModelFiles) {
      writeFileSync(path.join(dir, modelBlobKey(sha256)), readFileSync(file));
    }
    await upload();
    expect(bucket.puts.filter((key) => key === r2Key)).toHaveLength(1);
    expect(bucket.checksums.has(r2Key)).toBeTruthy();
    expect(bucket.puts.at(-1)).toBe(published);
  });

  it("uploads the model files a release directory carries, checked by hash, to a bucket without them", async () => {
    await serve(emptyBucket());
    mkdirSync(path.join(dir, "blobs/models"), { recursive: true });
    for (const { sha256, file } of fixtureModelFiles) {
      writeFileSync(path.join(dir, modelBlobKey(sha256)), readFileSync(file));
    }
    await upload();
    expect(bucket.puts).toStrictEqual(
      expect.arrayContaining(manifest.modelFiles.map(({ r2Key }) => r2Key))
    );
    expect(bucket.puts.at(-1)).toBe(published);
  });

  it("uploads nothing from a release directory whose model file isn't the release's", async () => {
    await serve(emptyBucket());
    mkdirSync(path.join(dir, "blobs/models"), { recursive: true });
    writeFileSync(path.join(dir, firstModelFile().r2Key), "other weights");
    await expect(upload()).rejects.toThrow(/doesn't match its hash/u);
    expect(bucket.puts).toStrictEqual([]);
  });

  it("publishes a release built before a model shipped, which names no model files, to a bucket without any", async () => {
    await serve(emptyBucket());
    writeRelease(
      dir,
      generateManifest({ ...info, modelFiles: [] }, fixture),
      fixture
    );
    await signDir();
    await upload();
    expect(bucket.puts.at(-1)).toBe(published);
  });

  it("uploads only the blobs the manifest references", async () => {
    const stray = "blobs/modules/stray";
    mkdirSync(path.dirname(path.join(dir, stray)), { recursive: true });
    writeFileSync(path.join(dir, stray), "not in the manifest");
    await upload();
    expect(bucket.puts).not.toContain(stray);
  });

  it("publishes a release as it has it only with a signature that verifies, stored right before it", async () => {
    const bytes = readFileSync(path.join(dir, "manifest.json"));
    const signatureFile = path.join(dir, RELEASE_SIGNATURE_FILE);
    const signature = readFileSync(signatureFile);
    rmSync(signatureFile);
    const unsigned = await outcomeOf(upload());
    writeFileSync(
      signatureFile,
      await signReleaseManifest(
        Buffer.from("another manifest"),
        testReleaseSigningKey
      )
    );
    const mismatched = await outcomeOf(upload());
    const putsBefore = bucket.puts.length;
    writeFileSync(signatureFile, signature);
    const signed = await outcomeOf(upload());

    expect({
      unsigned: unsigned.includes("isn't signed"),
      mismatched: mismatched.includes("has a signature that doesn't match it"),
      putsBefore,
      signed,
      problem: await signatureProblemOf(manifest.releaseId),
      lastPuts: bucket.puts.slice(-2),
    }).toStrictEqual({
      unsigned: true,
      mismatched: true,
      putsBefore: 0,
      signed: "ok",
      problem: undefined,
      lastPuts: [signatureKey(sha256Hex(bytes)), published],
    });
  });

  it("keeps the id it has, as Promote release publishes it", async () => {
    await upload();
    expect(bucket.objects.get(published)).toStrictEqual(
      readFileSync(path.join(dir, "manifest.json"))
    );
  });

  it("sends a request again when the network drops it or R2 answers 500, then publishes", async () => {
    const { key } = coreModule();
    bucket.faults.set(key, [{ answer: "drop" }, { answer: "500" }]);
    bucket.faults.set(published, [{ answer: "drop" }]);
    const stdout = await upload();

    expect({
      published: stdout.includes("Published"),
      blobStored: bucket.objects.has(key),
      faultsLeft: [...bucket.faults.values()].flat().length,
    }).toStrictEqual({ published: true, blobStored: true, faultsLeft: 0 });
  });

  it("reads an answer again when the connection drops halfway through its body", async () => {
    // Stored by another writer without its SHA-256: read whole to hash it.
    const { key, bytes } = coreModule();
    bucket.objects.set(key, bytes);
    bucket.faults.set(key, [
      { answer: "cut", method: "GET" },
      { answer: "cut", method: "GET" },
    ]);
    const stdout = await upload();

    expect({
      published: stdout.includes("Published"),
      faultsLeft: [...bucket.faults.values()].flat().length,
    }).toStrictEqual({ published: true, faultsLeft: 0 });
  });

  it("gives up on a request after 5 tries, publishing nothing", async () => {
    const { key } = coreModule();
    bucket.faults.set(
      key,
      Array.from({ length: 5 }, () => ({ answer: "drop" }))
    );
    const outcome = await outcomeOf(upload());

    expect({
      failed: outcome.includes(`HEAD ${key}`) && outcome.includes("5 tries"),
      tries: bucket.requests.filter((request) => request === `HEAD ${key}`)
        .length,
      published: bucket.objects.has(published),
    }).toStrictEqual({ failed: true, tries: 5, published: false });
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
