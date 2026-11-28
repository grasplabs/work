/**
 * publish-release.ts run as CI's jobs run it, holding no key to the
 * bucket: `stage`, then CI's signer (sign-manifest.ts, against KMS's
 * stand-in signing with the tests' key: fake-google.ts), then `finish`; against stand-ins for the outside systems it asks:
 * GitHub's token service; the staging admin's publish (apps/admin/src/
 * releases/publish.ts, tested in the admin), which gives the ids and the
 * links it is told to, and the manifest's only for a signature that
 * verifies; and R2 taking a PUT by an upload link only if absent (412),
 * checking the SHA-256 the link names. A link's PUT can be dropped by the
 * network, as one is.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { buffer, text } from "node:stream/consumers";

import { blobsOf, manifestKey } from "@grasp-os/shared/release";
import { releaseMonthPrefix } from "@grasp-os/shared/release-id";
import { releaseSignatureProblem } from "@grasp-os/shared/release-signature";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  releaseSigningKeys,
  strangerSigningKey,
  testReleaseSigningKey,
} from "../../packages/shared/test/release-signing-keys.ts";
import type { TestSigningKey } from "../../packages/shared/test/release-signing-keys.ts";
import { stampReleaseId } from "./assign-lib.ts";
import { pushToMain, runSigner, TEST_NOW } from "./fake-google.ts";
import { builds, info } from "./fixture-release.ts";
import { generateManifest, writeRelease } from "./manifest-lib.ts";

const SCRIPT = path.join(import.meta.dirname, "publish-release.ts");
const TRUST_TEST_KEY = path.join(import.meta.dirname, "trust-test-key.ts");
const BUCKET = "grasp-releases-staging";
const COMMIT = "1".repeat(40);
const REQUEST_TOKEN = "id-token-request-token";
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_UNAVAILABLE = 503;

const fixture = await builds();
const built = generateManifest(
  { ...info, releaseId: "dev-build", commit: COMMIT },
  fixture
);
/** Every blob the release carries: the model files never are. */
const blobKeys = blobsOf(built).map(({ key }) => key);

const sha256Base64 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64");

/** Runs a script, trusting the tests' key, resolving with its stdout; failing with its stderr. */
const run = async (args: string[], env: NodeJS.ProcessEnv): Promise<string> => {
  const child = spawn("node", ["--import", TRUST_TEST_KEY, ...args], {
    env,
  });
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

/** How a run ended: "ok", or what it said on its way out. */
const outcomeOf = async (running: Promise<unknown>): Promise<string> => {
  try {
    await running;
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** What the stand-in admin is told to answer, and what it saw. */
interface Admin {
  /**
   * The ids its starts give, in turn, as long as the last one given has no
   * manifest of the commit in the bucket; then that one, as published, as
   * the admin says from the commit's marker. `publishedAs` says so at once.
   */
  ids: string[];
  given: string[];
  publishedAs?: string;
  /** The keys it gives links for: those the bucket lacks. */
  missing: (keys: string[]) => string[];
  /** A manifest another writer puts right after finish gives its link. */
  takenAfterFinish?: Buffer;
  /** Whether its next answer is 503, as while GitHub's keys can't be fetched. */
  unavailableOnce: boolean;
  /**
   * A step whose first try's answer the network loses, the try taking so
   * long that the GitHub token it carried has expired.
   */
  lostOnce?: string;
  /** GitHub's tokens for the run, as issued; and those expired. */
  tokens: string[];
  expired: Set<string>;
  /** Each step it was asked, with the manifest's id. */
  asked: string[];
  /** The audiences GitHub's tokens were asked for. */
  audiences: string[];
}

/** R2 as the links reach it: objects by key, each PUT in order, and drops to make. */
interface Bucket {
  objects: Map<string, Buffer>;
  puts: string[];
  /** Keys whose next PUT the network drops after R2 stored it. */
  drops: Set<string>;
}

const manifestIdSchema = z.object({ releaseId: z.string() });

describe("publishing a release as CI does, through the staging admin", () => {
  // Ids of this month, as the admin gives only those, and as the signer
  // signs only those: its clock is set to `TEST_NOW`.
  const first = `${releaseMonthPrefix(new Date(TEST_NOW))}1`;
  const second = `${releaseMonthPrefix(new Date(TEST_NOW))}2`;
  let dir = "";
  let server: Server | undefined;
  let origin = "";
  let admin: Admin;
  let bucket: Bucket;

  /** A link to `key` on the stand-in bucket, as the admin signs one. */
  const linkTo = (key: string, sha256?: string) => ({
    key,
    url: `${origin}/${BUCKET}/${key}?X-Amz-Signature=signed`,
    headers: {
      "if-none-match": "*",
      ...(sha256 === undefined ? {} : { "x-amz-checksum-sha256": sha256 }),
    },
  });

  const answerAdmin = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<void> => {
    const body = await buffer(request);
    const step = url.searchParams.get("step") ?? "";
    if (admin.unavailableOnce) {
      admin.unavailableOnce = false;
      response
        .writeHead(HTTP_UNAVAILABLE)
        .end("Couldn't answer now; try again");
      return;
    }
    const token = request.headers.authorization?.replace(/^Bearer /u, "");
    if (
      token === undefined ||
      !admin.tokens.includes(token) ||
      admin.expired.has(token)
    ) {
      response.writeHead(HTTP_FORBIDDEN).end("Not CI's publish");
      return;
    }
    if (admin.lostOnce === step) {
      admin.lostOnce = undefined;
      admin.expired.add(token);
      request.socket.destroy();
      return;
    }
    admin.asked.push(
      `${step} ${manifestIdSchema.parse(JSON.parse(body.toString())).releaseId}`
    );
    if (step === "start") {
      const last = admin.given.at(-1);
      const stored =
        last === undefined ? undefined : bucket.objects.get(manifestKey(last));
      if (stored?.toString().includes(COMMIT) === true) {
        admin.publishedAs = last;
      }
      const id = admin.ids.shift() ?? "none";
      admin.given.push(id);
      response.writeHead(HTTP_OK).end(
        JSON.stringify(
          admin.publishedAs === undefined
            ? {
                id,
                uploads: admin.missing(blobKeys).map((key) => linkTo(key)),
              }
            : { publishedAs: admin.publishedAs }
        )
      );
      return;
    }
    const { releaseId } = manifestIdSchema.parse(JSON.parse(body.toString()));
    // As the admin does: an id published already is the commit's (any
    // manifest of it there) or another's, and a manifest's link only for a
    // signature that verifies.
    const published = bucket.objects.get(manifestKey(releaseId));
    if (published !== undefined) {
      if (published.toString().includes(COMMIT)) {
        response
          .writeHead(HTTP_OK)
          .end(JSON.stringify({ publishedAs: releaseId }));
      } else {
        response
          .writeHead(HTTP_CONFLICT)
          .end(`Release ${releaseId} is another's`);
      }
      return;
    }
    const sent = request.headers["x-release-signature"];
    const problem = await releaseSignatureProblem(
      body,
      typeof sent === "string" ? Buffer.from(sent, "base64url") : undefined,
      releaseSigningKeys,
      releaseId
    );
    if (problem !== undefined) {
      response
        .writeHead(HTTP_BAD_REQUEST)
        .end(`Release ${releaseId} ${problem}`);
      return;
    }
    response.writeHead(HTTP_OK).end(
      JSON.stringify({
        upload: linkTo(manifestKey(releaseId), sha256Base64(body)),
      })
    );
    if (admin.takenAfterFinish !== undefined) {
      bucket.objects.set(manifestKey(releaseId), admin.takenAfterFinish);
    }
  };

  const answerLink = async (
    request: IncomingMessage,
    response: ServerResponse,
    key: string
  ): Promise<void> => {
    const body = await buffer(request);
    const checksum = request.headers["x-amz-checksum-sha256"];
    if (
      request.method !== "PUT" ||
      request.headers["if-none-match"] !== "*" ||
      (typeof checksum === "string" && checksum !== sha256Base64(body))
    ) {
      response.writeHead(HTTP_BAD_REQUEST).end();
      return;
    }
    if (bucket.objects.has(key)) {
      response.writeHead(HTTP_PRECONDITION_FAILED).end();
      return;
    }
    bucket.objects.set(key, body);
    bucket.puts.push(key);
    if (bucket.drops.delete(key)) {
      response.socket?.destroy();
      return;
    }
    response.writeHead(HTTP_OK).end();
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-publish-test-"));
    writeRelease(dir, built, fixture);
    admin = {
      ids: [first, second],
      given: [],
      missing: (keys) => keys,
      unavailableOnce: false,
      tokens: [],
      expired: new Set(),
      asked: [],
      audiences: [],
    };
    bucket = { objects: new Map(), puts: [], drops: new Set() };
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(
          request.url ?? "",
          `http://${request.headers.host}`
        );
        if (url.pathname === "/token") {
          admin.audiences.push(url.searchParams.get("audience") ?? "");
          const fine =
            request.headers.authorization === `bearer ${REQUEST_TOKEN}`;
          const token = `github-token-${admin.tokens.length + 1}`;
          if (fine) {
            admin.tokens.push(token);
          }
          response
            .writeHead(fine ? HTTP_OK : HTTP_FORBIDDEN)
            .end(fine ? JSON.stringify({ value: token }) : undefined);
        } else if (url.pathname === "/release-publish") {
          await answerAdmin(request, response, url);
        } else {
          await answerLink(
            request,
            response,
            url.pathname.slice(`/${BUCKET}/`.length)
          );
        }
      })();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port for the stand-in");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server?.close();
    if (server) {
      await once(server, "close");
    }
    rmSync(dir, { force: true, recursive: true });
  });

  /**
   * Publishes as CI's jobs do, main's head being `head`: stage, then, when
   * it staged the release, sign it with `key`, then finish. What the steps
   * said. The admin is reached as `localhost`, GitHub's token service as
   * `127.0.0.1`: two origins, so a token asked for the wrong audience
   * shows.
   */
  const publish = async (
    head = COMMIT,
    key: TestSigningKey = testReleaseSigningKey
  ): Promise<string> => {
    const env = {
      PATH: process.env.PATH,
      RELEASE_PUBLISH_URL: `${origin.replace("127.0.0.1", "localhost")}/release-publish`,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    };
    const staged = path.join(dir, "staged");
    const stamped = path.join(staged, "manifest.json");
    const said = await run(
      [SCRIPT, "stage", "--release", dir, "--out", stamped, "--head", head],
      env
    );
    if (!existsSync(stamped)) {
      return said;
    }
    const signed = await runSigner(staged, { env: pushToMain(COMMIT), key });
    if (signed.code !== 0) {
      throw new Error(signed.output);
    }
    return (
      said +
      (await run(
        [SCRIPT, "finish", "--manifest", stamped, "--head", head],
        env
      ))
    );
  };

  /** The manifest as built, stamped with `id`, as CI signs it. */
  const stampedAs = (id: string): Buffer =>
    stampReleaseId(readFileSync(path.join(dir, "manifest.json")), id)
      .manifestBytes;

  it("uploads each blob the admin asks for by its link, then the manifest stamped with the id it gave, signed by CI, last", async () => {
    const [kept] = blobKeys;
    admin.missing = (keys) => keys.filter((key) => key !== kept);
    const stdout = await publish();

    expect({
      published: stdout.includes(`release ${first}`),
      asked: admin.asked,
      audiences: new Set(admin.audiences),
      blobs: bucket.puts.slice(0, -1).toSorted(),
      last: bucket.puts.at(-1),
      manifest: bucket.objects.get(manifestKey(first)),
    }).toStrictEqual({
      published: true,
      asked: ["start dev-build", `finish ${first}`],
      audiences: new Set([origin.replace("127.0.0.1", "localhost")]),
      blobs: blobKeys.filter((key) => key !== kept).toSorted(),
      last: manifestKey(first),
      manifest: stampedAs(first),
    });
  });

  it("publishes nothing, and fails, when another manifest took its id before finish, or between finish and its manifest's link", async () => {
    bucket.objects.set(manifestKey(first), Buffer.from("another release"));
    const before = await outcomeOf(publish());
    bucket.objects.clear();
    admin.ids = [second];
    admin.given = [];
    admin.takenAfterFinish = Buffer.from("another release");
    const between = await outcomeOf(publish());

    expect({
      before: before.includes("refused the publish's finish: 409"),
      between: between.includes("refused the publish's finish: 409"),
      ids: [first, second].map((id) =>
        bucket.objects.get(manifestKey(id))?.toString()
      ),
    }).toStrictEqual({
      before: true,
      between: true,
      ids: [undefined, "another release"],
    });
  });

  it("puts a link's object again when the network drops the answer, and takes its own manifest there for published, as the admin says", async () => {
    const [key = ""] = blobKeys;
    bucket.drops.add(key);
    bucket.drops.add(manifestKey(first));
    const stdout = await publish();

    expect({
      blob: bucket.objects.has(key),
      // Its manifest's PUT found its own bytes there (412): it asks the
      // admin again, which says the commit is published.
      asked: admin.asked,
      published: stdout.includes(`release ${first}`),
      manifest: bucket.objects.get(manifestKey(first)),
    }).toStrictEqual({
      blob: true,
      asked: ["start dev-build", `finish ${first}`, `finish ${first}`],
      published: true,
      manifest: stampedAs(first),
    });
  });

  it("asks the admin again when it answers 503, as while GitHub's keys can't be fetched, then publishes", async () => {
    admin.unavailableOnce = true;
    const stdout = await publish();
    expect({
      published: stdout.includes(`release ${first}`),
      asked: admin.asked,
    }).toStrictEqual({
      published: true,
      asked: ["start dev-build", `finish ${first}`],
    });
  });

  it("tries a step again with a new GitHub token when its answer was lost after the token it carried expired, then publishes", async () => {
    admin.lostOnce = "finish";
    const stdout = await publish();
    expect({
      published: stdout.includes(`release ${first}`),
      asked: admin.asked,
      expired: admin.expired.size,
    }).toStrictEqual({
      published: true,
      asked: ["start dev-build", `finish ${first}`],
      expired: 1,
    });
  });

  it("stages nothing again when the admin says the commit is published", async () => {
    admin.publishedAs = first;
    const stdout = await publish();
    expect({
      published: stdout.includes("Published"),
      staged: existsSync(path.join(dir, "staged")),
      puts: bucket.puts,
    }).toStrictEqual({ published: false, staged: false, puts: [] });
  });

  it("publishes no manifest signed with a key Grasp doesn't trust: the admin gives it no link", async () => {
    const outcome = await outcomeOf(publish(COMMIT, strangerSigningKey));

    expect({
      refused: outcome.includes("refused the publish's finish: 400 Release"),
      manifests: [...bucket.objects.keys()].filter((key) =>
        key.startsWith("releases/")
      ),
    }).toStrictEqual({ refused: true, manifests: [] });
  });

  it("publishes nothing once main has moved on from its commit", async () => {
    const stdout = await publish("2".repeat(40));
    expect({ asked: admin.asked, puts: bucket.puts }).toStrictEqual({
      asked: [],
      puts: [],
    });
    expect(stdout).toContain("Not publishing");
  });

  it("publishes nothing when the admin asks for a blob the release doesn't carry", async () => {
    admin.missing = () => ["blobs/modules/not-in-the-release"];
    const outcome = await outcomeOf(publish());
    expect({
      refused: outcome.includes("which the release doesn't carry"),
      puts: bucket.puts,
    }).toStrictEqual({ refused: true, puts: [] });
  });
});
