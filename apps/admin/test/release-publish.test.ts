/**
 * CI's publish through the staging admin (src/releases/publish.ts),
 * through the Worker's entry, with no Access JWT: GitHub's token is the
 * only credential. A stand-in for GitHub's token service serves its keys
 * at their real address and signs the tokens a run would get, and the
 * ones it never would. The bucket is the test pool's R2.
 *
 * Threat model: anyone on the internet can reach this path. Without a
 * token GitHub signed for CI's publish of a push to main in the stage's
 * environment, for this admin, they must get no id and no link. A run
 * must get nothing for another commit than its own, and a manifest's link
 * only for the id its commit was given, not yet published, its blobs read
 * back, and signed by a key Grasp trusts. A link must reach one object,
 * only if absent, for a limited time, with the bytes the manifest names
 * where it names their SHA-256. The upload key must never leave the
 * admin.
 */
import { toBase64, toBase64Url } from "@grasp-os/shared/encoding";
import {
  commitKey,
  manifestKey,
  sha256OfBytes,
} from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { nextReleaseId, releaseMonthPrefix } from "@grasp-os/shared/release-id";
import { signatureKey } from "@grasp-os/shared/release-signature";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import {
  signReleaseManifest,
  strangerSigningKey,
  testReleaseSigningKey,
} from "../../../packages/shared/test/release-signing-keys.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents, releaseBlobs } from "../src/db/schema.ts";
import { MAX_MANIFEST_BYTES } from "../src/releases/import.ts";
import worker from "../src/server.ts";
import { testReleaseMonth } from "./release-clock.ts";
import { buildRelease, putBlobs } from "./releases.ts";
import type { TestRelease } from "./releases.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const db = adminDatabase(env.DB);
const issuer = "https://token.actions.githubusercontent.com";
const jwksUrl = `${issuer}/.well-known/jwks`;
const origin = "https://admin.staging.grasp.test";
const keyId = "github-test-key";
const encoder = new TextEncoder();

const githubKeys = await generateKeyPair("RS256", { extractable: true });
const strangerKeys = await generateKeyPair("RS256");
const githubJwk = await exportJWK(githubKeys.publicKey);

/** The staging admin's env. */
const staging = { ...env, STAGE: "staging" };

/** The R2 key the links are signed with, made up for the tests. */
const uploadKey = {
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret",
};

/** The claims of CI's publish run of `sha`, as GitHub puts them in its token. */
const publishClaims = (sha: string): JWTPayload => ({
  iss: issuer,
  aud: origin,
  sub: "repo:grasplabs/work:environment:staging",
  repository: "grasplabs/work",
  repository_id: "1386316902",
  repository_owner: "grasplabs",
  workflow_ref: "grasplabs/work/.github/workflows/ci.yml@refs/heads/main",
  job_workflow_ref: "grasplabs/work/.github/workflows/ci.yml@refs/heads/main",
  ref: "refs/heads/main",
  ref_type: "branch",
  event_name: "push",
  environment: "staging",
  runner_environment: "github-hosted",
  sha,
  run_id: "46000000001",
  run_attempt: "1",
});

/** A token as GitHub signs one, with `claims`, expiring in `expiresIn` seconds. */
const githubToken = async (
  claims: JWTPayload,
  { stranger = false, expiresIn = 300 } = {}
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(stranger ? strangerKeys.privateKey : githubKeys.privateKey);
};

/**
 * CI's ask of `step` with `body`, with `token` as its bearer token, and,
 * for finish, `signature` (a signature file) as CI sends it.
 */
const ask = async (
  step: string,
  body: BodyInit,
  token: string | undefined,
  signature?: Uint8Array
): Promise<Response> =>
  await worker.fetch(
    new Request(`${origin}/release-publish?step=${step}`, {
      method: "POST",
      body,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(signature === undefined
          ? {}
          : { "x-release-signature": toBase64Url(signature) }),
      },
    }),
    staging
  );

const statusOf = async (
  step: string,
  body: BodyInit,
  token: string | undefined,
  signature?: Uint8Array
): Promise<number> => {
  const response = await ask(step, body, token, signature);
  return response.status;
};

/** The signature file of `manifest`, as CI's sign-release makes it. */
const signed = async (manifest: string): Promise<Uint8Array> =>
  await signReleaseManifest(encoder.encode(manifest), testReleaseSigningKey);

const linkSchema = z.object({
  key: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
});
const startSchema = z.union([
  z.object({ publishedAs: z.string() }),
  z.object({ id: z.string(), uploads: z.array(linkSchema) }),
]);
const finishSchema = z.object({ upload: linkSchema });

/** A built release, as CI's release job builds one: under a local id. */
const built = async (notes: string): Promise<TestRelease> =>
  await buildRelease({ notes }, "dev-build");

/** `release`'s manifest stamped with `id`, as CI sends it to finish. */
const stamped = (release: TestRelease, id: string): string =>
  `${JSON.stringify({ ...release.manifest, releaseId: id } satisfies ReleaseManifest, null, 2)}\n`;

/** The id the month's next release would get now, from what the bucket holds. */
const monthsNext = async (): Promise<string> => {
  const now = testReleaseMonth;
  const listed = await env.RELEASES.list({
    prefix: `releases/${releaseMonthPrefix(now)}`,
    delimiter: "/",
  });
  return nextReleaseId(
    listed.delimitedPrefixes.map((each) => each.slice("releases/".length, -1)),
    now
  );
};

/** Starts `release`'s publish as its run, its answer parsed. */
const start = async (release: TestRelease) => {
  const response = await ask(
    "start",
    release.manifestText,
    await githubToken(publishClaims(release.manifest.commit))
  );
  return startSchema.parse(await response.json());
};

describe("CI's publish through the staging admin", () => {
  useStoreSecrets({ deployer: "deployer-token" });

  beforeEach(async () => {
    await setStoreSecret(
      env.RELEASE_UPLOAD_KEY,
      "RELEASE_UPLOAD_KEY",
      JSON.stringify(uploadKey)
    );
    // GitHub's keys at their real address; nothing else goes out.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== jwksUrl) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      await request.body?.cancel();
      return Response.json({
        keys: [{ ...githubJwk, kid: keyId, alg: "RS256", use: "sig" }],
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives a new commit the month's next id, named in its marker, and a link only for each blob the bucket lacks", async () => {
    const release = await built("feat(core): new");
    const [kept, ...missing] = [...release.blobs.keys()];
    await putBlobs({
      blobs: new Map([
        [kept ?? "", release.blobs.get(kept ?? "") ?? new Uint8Array()],
      ]),
    });
    const expected = await monthsNext();

    const plan = await start(release);
    const marker = await env.RELEASES.get(commitKey(release.manifest.commit));
    // A job that calls no reusable workflow may come without one named.
    const { job_workflow_ref: _direct, ...directClaims } = publishClaims(
      release.manifest.commit
    );
    const direct = await statusOf(
      "start",
      release.manifestText,
      await githubToken(directClaims)
    );

    expect({
      plan:
        "id" in plan
          ? { id: plan.id, keys: plan.uploads.map(({ key }) => key).toSorted() }
          : plan,
      marker: await marker?.text(),
      direct,
    }).toStrictEqual({
      plan: { id: expected, keys: missing.toSorted() },
      marker: `${expected}\n`,
      direct: 200,
    });
  });

  it("signs each link for one object in the stage's bucket, only if absent, for 15 minutes, with the SHA-256 the manifest names", async () => {
    const release = await built("feat(core): links");
    const plan = await start(release);
    const module = release.manifest.workers.core?.modules[0];
    const link =
      "uploads" in plan
        ? plan.uploads.find(({ key }) => key === module?.r2Key)
        : undefined;
    const url = new URL(link?.url ?? "https://none.test");

    expect({
      at: `${url.origin}${url.pathname}`,
      expires: url.searchParams.get("X-Amz-Expires"),
      signed: url.searchParams
        .get("X-Amz-SignedHeaders")
        ?.split(";")
        .filter((header) => header !== "x-amz-content-sha256"),
      signature: url.searchParams.has("X-Amz-Signature"),
      secretInLink: link?.url.includes(uploadKey.secretAccessKey),
      headers: link?.headers,
    }).toStrictEqual({
      at: `https://e8ff423bc46eb025fca37494777c1cc0.eu.r2.cloudflarestorage.com/grasp-releases-staging/${module?.r2Key ?? ""}`,
      expires: "900",
      signed: ["host", "if-none-match", "x-amz-checksum-sha256"],
      signature: true,
      secretInLink: false,
      headers: {
        "if-none-match": "*",
        "x-amz-checksum-sha256": toBase64(
          Uint8Array.from((module?.sha256 ?? "").match(/../gu) ?? [], (pair) =>
            Number.parseInt(pair, 16)
          )
        ),
      },
    });
  });

  it("gives a commit its id again while that id's manifest isn't published, says it's published once it is, and gives the next once another release took it", async () => {
    const release = await built("feat(core): again");
    const first = await start(release);
    const id = "id" in first ? first.id : "";
    const again = await start(release);
    await env.RELEASES.put(manifestKey(id), stamped(release, id));
    const published = await start(release);

    const other = await built("feat(core): lost its id");
    const otherFirst = await start(other);
    const otherId = "id" in otherFirst ? otherFirst.id : "";
    const taker = await built("feat(core): took it");
    await env.RELEASES.put(manifestKey(otherId), stamped(taker, otherId));
    const otherAgain = await start(other);

    expect({
      again: "id" in again ? again.id : again,
      published,
      otherAgain: "id" in otherAgain ? otherAgain.id === otherId : otherAgain,
    }).toStrictEqual({
      again: id,
      published: { publishedAs: id },
      otherAgain: false,
    });
  });

  it("deletes a blob an interrupted run or a leaked link left at another size, and links it again; gives no id while a model file isn't there", async () => {
    // Blobs of its own: nothing else in the file's bucket names them.
    const release = await buildRelease(
      {
        notes: "feat(core): left behind",
        core: `export default { leftBehind: "${crypto.randomUUID()}" };`,
        assets: { "/index.html": `<html>${crypto.randomUUID()}</html>` },
      },
      "dev-build"
    );
    const module = release.manifest.workers.core?.modules[0];
    const [asset] = Object.values(release.manifest.assets);
    await env.RELEASES.put(module?.r2Key ?? "", "other bytes of other size");
    await env.RELEASES.put(asset?.r2Key ?? "", "x");
    const plan = await start(release);
    const withModel = await buildRelease(
      { notes: "feat(core): model", modelFiles: { "model.onnx": "weights" } },
      "dev-build"
    );

    expect({
      linked:
        "uploads" in plan
          ? plan.uploads
              .map(({ key }) => key)
              .filter((key) => key === module?.r2Key || key === asset?.r2Key)
              .toSorted()
          : plan,
      gone: [
        await env.RELEASES.head(module?.r2Key ?? ""),
        await env.RELEASES.head(asset?.r2Key ?? ""),
      ],
      noModel: await statusOf(
        "start",
        withModel.manifestText,
        await githubToken(publishClaims(withModel.manifest.commit))
      ),
    }).toStrictEqual({
      linked: [module?.r2Key ?? "", asset?.r2Key ?? ""].toSorted(),
      gone: [null, null],
      noModel: 409,
    });
  });

  it.each(["imported", "published, not imported yet"])(
    "never deletes a blob a release %s names on a new manifest's word, and gives that manifest no id",
    async (state) => {
      // A module of its own, which a release names.
      const release = await buildRelease(
        {
          notes: "feat(core): kept",
          core: `export default { kept: "${crypto.randomUUID()}" };`,
        },
        "dev-build"
      );
      await putBlobs(release);
      const module = release.manifest.workers.core?.modules[0];
      if (state === "imported") {
        await db
          .insert(releaseBlobs)
          .values({ releaseId: "26.10.3", blobKey: module?.r2Key ?? "" });
      } else {
        // Its manifest is up, and its import hasn't started.
        const id = `26.09.${String(Math.floor(Math.random() * 90_000) + 10_000)}`;
        await env.RELEASES.put(manifestKey(id), stamped(release, id));
      }
      // A manifest of a commit CI may publish, naming that module at another
      // size: a token for main's commit doesn't vouch for what it names.
      const lying = {
        ...release.manifest,
        workers: {
          ...release.manifest.workers,
          core: {
            ...release.manifest.workers.core,
            modules: [{ ...module, size: (module?.size ?? 0) + 1 }],
          },
        },
      };
      const status = await statusOf(
        "start",
        JSON.stringify(lying),
        await githubToken(publishClaims(release.manifest.commit))
      );
      const stored = await env.RELEASES.head(module?.r2Key ?? "");

      expect({ status, kept: stored?.size }).toStrictEqual({
        status: 409,
        kept: module?.size,
      });
    }
  );

  it("never reads an object at a manifest's or a marker's key larger than one can be, as anyone who can write the bucket could plant one there for good", async () => {
    // Blobs of its own: nothing else in the file's bucket names them.
    const release = await buildRelease(
      {
        notes: "feat(core): planted",
        core: `export default { planted: "${crypto.randomUUID()}" };`,
      },
      "dev-build"
    );
    const module = release.manifest.workers.core?.modules[0];
    await env.RELEASES.put(module?.r2Key ?? "", "other bytes of other size");
    // A manifest naming that module, under an unused id, too large to be
    // one: read, it would spare the module and this start would get 409.
    const plantedId = `26.09.${String(Math.floor(Math.random() * 90_000) + 10_000)}`;
    await env.RELEASES.put(
      manifestKey(plantedId),
      JSON.stringify({
        ...release.manifest,
        releaseId: plantedId,
        notes: "x".repeat(MAX_MANIFEST_BYTES),
      })
    );
    // The commit's marker, too large to be one, naming an id of this month
    // that's free: read, this start would be given that id.
    await env.RELEASES.put(
      commitKey(release.manifest.commit),
      `${releaseMonthPrefix(testReleaseMonth)}777777\n${" ".repeat(100)}`
    );
    const expected = await monthsNext();
    const plan = await start(release);
    const gone = await env.RELEASES.head(module?.r2Key ?? "");
    // Out of the bucket the files share, whose imports would try it.
    await env.RELEASES.delete(manifestKey(plantedId));

    expect({
      id: "id" in plan ? plan.id : plan,
      relinked:
        "uploads" in plan &&
        plan.uploads.some(({ key }) => key === module?.r2Key),
      gone,
    }).toStrictEqual({ id: expected, relinked: true, gone: null });
  });

  it("takes the manifest stamped with the commit's id as CI signed it, stores the signature, audited, and gives the manifest's link carrying its SHA-256", async () => {
    const release = await built("feat(core): signed");
    const plan = await start(release);
    const id = "id" in plan ? plan.id : "";
    // Through its links, as CI puts them.
    await putBlobs(release);
    const manifest = stamped(release, id);
    const signature = await signed(manifest);
    const response = await ask(
      "finish",
      manifest,
      await githubToken(publishClaims(release.manifest.commit)),
      signature
    );
    const { upload } = finishSchema.parse(await response.json());
    const manifestSha256 = await sha256OfBytes(encoder.encode(manifest));
    const storedSignature = await env.RELEASES.get(
      signatureKey(manifestSha256)
    );
    const storedBytes = new Uint8Array(
      (await storedSignature?.arrayBuffer()) ?? new ArrayBuffer(0)
    );
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "release.publish"),
          eq(auditEvents.target, id)
        )
      );
    const audited: unknown = JSON.parse(event?.detail ?? "{}");

    expect({
      stored: storedBytes,
      key: upload.key,
      headers: upload.headers,
      audited,
    }).toStrictEqual({
      stored: signature,
      key: manifestKey(id),
      headers: {
        "if-none-match": "*",
        "x-amz-checksum-sha256": toBase64(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", encoder.encode(manifest))
          )
        ),
        "content-type": "application/json",
      },
      audited: {
        commit: release.manifest.commit,
        manifestSha256,
        run: "46000000001",
        attempt: "1",
      },
    });
  });

  it("takes only the id the commit was given, and once its manifest is published says so", async () => {
    const release = await built("feat(core): only its id");
    const plan = await start(release);
    const id = "id" in plan ? plan.id : "";
    await putBlobs(release);
    const token = await githubToken(publishClaims(release.manifest.commit));
    const otherId = `${releaseMonthPrefix(testReleaseMonth)}999999`;
    const another = await statusOf(
      "finish",
      stamped(release, otherId),
      token,
      await signed(stamped(release, otherId))
    );
    const neverStarted = await built("feat(core): never started");
    const unstarted = await statusOf(
      "finish",
      stamped(neverStarted, id),
      await githubToken(publishClaims(neverStarted.manifest.commit)),
      await signed(stamped(neverStarted, id))
    );
    await env.RELEASES.put(manifestKey(id), stamped(release, id));
    const published = await ask(
      "finish",
      stamped(release, id),
      token,
      await signed(stamped(release, id))
    );

    expect({
      another,
      unstarted,
      published: await published.json(),
    }).toStrictEqual({
      another: 409,
      unstarted: 409,
      published: { publishedAs: id },
    });
  });

  it("gives no link for a manifest that isn't signed, is signed by a key nobody trusts, or whose signature is another manifest's, and stores no signature", async () => {
    const release = await built("feat(core): unsigned");
    const plan = await start(release);
    const id = "id" in plan ? plan.id : "";
    await putBlobs(release);
    const manifest = stamped(release, id);
    const token = await githubToken(publishClaims(release.manifest.commit));
    const statuses = {
      unsigned: await statusOf("finish", manifest, token),
      stranger: await statusOf(
        "finish",
        manifest,
        token,
        await signReleaseManifest(encoder.encode(manifest), strangerSigningKey)
      ),
      another: await statusOf(
        "finish",
        manifest,
        token,
        await signed(stamped(release, `${id}0`))
      ),
      garbage: await statusOf("finish", manifest, token, encoder.encode("{")),
    };

    expect({
      statuses,
      stored: await env.RELEASES.head(
        signatureKey(await sha256OfBytes(encoder.encode(manifest)))
      ),
    }).toStrictEqual({
      statuses: { unsigned: 400, stranger: 400, another: 400, garbage: 400 },
      stored: null,
    });
  });

  it("gives no link while a blob the manifest names is missing, nor for a static file left behind with other bytes of its size, which it deletes so the next start links it again", async () => {
    // Blobs of its own: nothing else in the file's bucket names them.
    const release = await buildRelease(
      {
        notes: "feat(core): read back",
        core: `export default { readBack: "${crypto.randomUUID()}" };`,
        assets: { "/index.html": `<html>${crypto.randomUUID()}</html>` },
      },
      "dev-build"
    );
    const token = await githubToken(publishClaims(release.manifest.commit));
    const first = await start(release);
    const id = "id" in first ? first.id : "";
    const signature = await signed(stamped(release, id));
    const missing = await statusOf(
      "finish",
      stamped(release, id),
      token,
      signature
    );
    // Every blob put, but the static file with other bytes of its size,
    // as a leaked link or an interrupted run could leave it: its head
    // says nothing wrong, so the next start gives no link for it.
    await putBlobs(release);
    const [asset] = Object.values(release.manifest.assets);
    const original = release.blobs.get(asset?.r2Key ?? "") ?? new Uint8Array();
    await env.RELEASES.put(asset?.r2Key ?? "", original.toReversed());
    const next = await start(release);
    const poisoned = await statusOf(
      "finish",
      stamped(release, id),
      token,
      signature
    );
    const deleted = (await env.RELEASES.head(asset?.r2Key ?? "")) === null;
    const again = await start(release);

    expect({
      missing,
      unseenAtStart:
        "uploads" in next &&
        !next.uploads.some(({ key }) => key === asset?.r2Key),
      poisoned,
      deleted,
      linkAgain:
        "uploads" in again &&
        again.uploads.some(({ key }) => key === asset?.r2Key),
      signed: await env.RELEASES.head(
        signatureKey(await sha256OfBytes(encoder.encode(stamped(release, id))))
      ),
    }).toStrictEqual({
      missing: 409,
      unseenAtStart: true,
      poisoned: 409,
      deleted: true,
      linkAgain: true,
      signed: null,
    });
  });

  it("refuses at finish, by its head and before reading it, a static file a leaked link put larger than the manifest says, and deletes it", async () => {
    const release = await buildRelease(
      {
        notes: "feat(core): oversized",
        assets: { "/index.html": `<html>${crypto.randomUUID()}</html>` },
      },
      "dev-build"
    );
    const plan = await start(release);
    const id = "id" in plan ? plan.id : "";
    await putBlobs(release);
    const [asset] = Object.values(release.manifest.assets);
    // Far more than the manifest names: a leaked link takes up to 5 GiB.
    await env.RELEASES.put(asset?.r2Key ?? "", new Uint8Array(1024 * 1024));
    const manifest = stamped(release, id);
    const reads: string[] = [];
    const get = env.RELEASES.get.bind(env.RELEASES);
    vi.spyOn(env.RELEASES, "get").mockImplementation(async (key, options) => {
      reads.push(key);
      return await get(key, options);
    });
    const status = await statusOf(
      "finish",
      manifest,
      await githubToken(publishClaims(release.manifest.commit)),
      await signed(manifest)
    );

    expect({
      status,
      read: reads.includes(asset?.r2Key ?? ""),
      deleted: (await env.RELEASES.head(asset?.r2Key ?? "")) === null,
    }).toStrictEqual({ status: 409, read: false, deleted: true });
  });

  it("gives no manifest link once a model file the release names is gone since start, as retention may delete one", async () => {
    const release = await buildRelease(
      {
        notes: "feat(core): model gone",
        modelFiles: { "model.onnx": `weights ${crypto.randomUUID()}` },
      },
      "dev-build"
    );
    await putBlobs(release);
    const plan = await start(release);
    const id = "id" in plan ? plan.id : "";
    const [model] = release.manifest.modelFiles;
    await env.RELEASES.delete(model?.r2Key ?? "");
    const manifest = stamped(release, id);
    const status = await statusOf(
      "finish",
      manifest,
      await githubToken(publishClaims(release.manifest.commit)),
      await signed(manifest)
    );

    expect({
      status,
      signature: await env.RELEASES.head(
        signatureKey(await sha256OfBytes(encoder.encode(manifest)))
      ),
    }).toStrictEqual({ status: 409, signature: null });
  });

  it("never takes an id of a month gone: a commit marked with one is given this month's next", async () => {
    const release = await built("feat(core): across a month's end");
    await env.RELEASES.put(commitKey(release.manifest.commit), "26.10.7\n");
    const token = await githubToken(publishClaims(release.manifest.commit));
    const expected = await monthsNext();
    const late = await statusOf(
      "finish",
      stamped(release, "26.10.7"),
      token,
      await signed(stamped(release, "26.10.7"))
    );
    const plan = await start(release);
    const marker = await env.RELEASES.get(commitKey(release.manifest.commit));

    expect({
      late,
      id: "id" in plan ? plan.id : plan,
      marker: await marker?.text(),
    }).toStrictEqual({ late: 409, id: expected, marker: `${expected}\n` });
  });

  it("answers 503, which CI tries again, while GitHub's keys can't be fetched, never 403, and answers once they can", async () => {
    const release = await built("feat(core): keys down");
    // A key id the kept keys don't have, as after GitHub rotates them: the
    // admin fetches them again, and GitHub answers 500.
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      await request.body?.cancel();
      return new Response("unavailable", { status: 500 });
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT(publishClaims(release.manifest.commit))
      .setProtectedHeader({ alg: "RS256", kid: "rotated-key" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(githubKeys.privateKey);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      // The failed fetch is logged; the test reads the answer.
    });
    const down = await statusOf("start", release.manifestText, token);
    // Asked again within the 30 s after that failed fetch: not fetched
    // again, and still not taken for a forged token.
    const retried = await statusOf("start", release.manifestText, token);
    errors.mockRestore();
    // Past those 30 s, GitHub serves the rotated key.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      await request.body?.cancel();
      return Response.json({
        keys: ["rotated-key", keyId].map((kid) => ({
          ...githubJwk,
          kid,
          alg: "RS256",
          use: "sig",
        })),
      });
    });
    const recovered = await statusOf("start", release.manifestText, token);

    expect({ down, retried, recovered }).toStrictEqual({
      down: 503,
      retried: 503,
      recovered: 200,
    });
  });

  it("refuses anyone but CI's publish of a push to main, in the stage's environment, for this admin", async () => {
    const release = await built("feat(core): forged");
    const claims = publishClaims(release.manifest.commit);
    const tokens = {
      none: undefined,
      notJwt: "not-a-jwt",
      strangerKey: await githubToken(claims, { stranger: true }),
      expired: await githubToken(claims, { expiresIn: -60 }),
      otherIssuer: await githubToken({ ...claims, iss: "https://evil.test" }),
      otherAudience: await githubToken({
        ...claims,
        aud: "https://admin.grasp.test",
      }),
      fork: await githubToken({
        ...claims,
        repository: "someone/work",
        repository_id: "1",
      }),
      recreated: await githubToken({ ...claims, repository_id: "2" }),
      otherWorkflow: await githubToken({
        ...claims,
        workflow_ref:
          "grasplabs/work/.github/workflows/promote-release.yml@refs/heads/main",
      }),
      reusableWorkflow: await githubToken({
        ...claims,
        job_workflow_ref:
          "grasplabs/work/.github/workflows/deploy-platform.yml@refs/heads/main",
      }),
      branch: await githubToken({
        ...claims,
        ref: "refs/heads/feat/x",
        workflow_ref:
          "grasplabs/work/.github/workflows/ci.yml@refs/heads/feat/x",
      }),
      pullRequest: await githubToken({ ...claims, event_name: "pull_request" }),
      byHand: await githubToken({ ...claims, event_name: "workflow_dispatch" }),
      nightly: await githubToken({ ...claims, event_name: "schedule" }),
      productionEnvironment: await githubToken({
        ...claims,
        environment: "production",
      }),
      selfHosted: await githubToken({
        ...claims,
        runner_environment: "self-hosted",
      }),
    };

    const statuses = Object.fromEntries(
      await Promise.all(
        Object.entries(tokens).map(
          async ([name, token]) =>
            [
              name,
              await statusOf("start", release.manifestText, token),
            ] as const
        )
      )
    );
    const marker = await env.RELEASES.head(commitKey(release.manifest.commit));

    expect({ statuses, marked: marker !== null }).toStrictEqual({
      statuses: Object.fromEntries(
        Object.keys(tokens).map((name) => [name, 403])
      ),
      marked: false,
    });
  });

  it("answers nothing for another commit than the run's, nor for what isn't a manifest", async () => {
    const release = await built("feat(core): other commit");
    const otherRun = await githubToken(publishClaims("b".repeat(40)));
    const ownRun = await githubToken(publishClaims(release.manifest.commit));

    expect({
      otherCommit: await statusOf("start", release.manifestText, otherRun),
      notManifest: await statusOf("start", "{ not json", ownRun),
      tooLarge: await statusOf(
        "start",
        `{"padding":"${"x".repeat(1_000_001)}"}`,
        ownRun
      ),
      noStep: await statusOf("sign", release.manifestText, ownRun),
    }).toStrictEqual({
      otherCommit: 403,
      notManifest: 400,
      tooLarge: 413,
      noStep: 405,
    });
  });

  it("takes no release on an admin without its upload key, as production's, nor with one it can't use", async () => {
    const release = await built("feat(core): keyless");
    const token = await githubToken(publishClaims(release.manifest.commit));
    await setStoreSecret(env.RELEASE_UPLOAD_KEY, "RELEASE_UPLOAD_KEY", "");
    const noUploadKey = await statusOf("start", release.manifestText, token);
    await setStoreSecret(env.RELEASE_UPLOAD_KEY, "RELEASE_UPLOAD_KEY", "{");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      // The unusable key is logged; the test reads the answer.
    });
    const unusable = await statusOf("start", release.manifestText, token);
    errors.mockRestore();

    expect({ noUploadKey, unusable }).toStrictEqual({
      noUploadKey: 404,
      unusable: 503,
    });
  });
});
