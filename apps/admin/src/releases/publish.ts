/**
 * CI's publish of a release (scripts/release/publish-release.ts), for
 * which CI holds no key to the bucket: GitHub's token for the run
 * (src/releases/github-oidc.ts) is its credential, and the admin gives it
 * upload links good for 15 minutes, each for one object, only if absent.
 * Two steps, each a `POST` of a manifest to `/release-publish`, each from
 * a job of its own, with CI's sign-release job between them
 * (.github/workflows/ci.yml):
 *
 * - `?step=start`, the manifest as built: the release's id, and a link for
 *   each blob the bucket lacks. The id is the one this commit's marker
 *   (`commits/<sha>`) names while that id's manifest isn't published and
 *   it's this month's, else the month's next (@grasp-os/shared/release-id),
 *   which the marker then names. Already published as the commit's: that
 *   id, and nothing to do. Each blob the bucket holds is checked by its
 *   head, as the import checks one (`storedBlobProblem`); one that doesn't
 *   match is deleted and gets a link again. Each model file the release
 *   names must be there as the import takes it (`storedModelFileProblem`).
 * - `?step=finish`, the manifest stamped with that id, still this month's,
 *   with its signature as sign-release made it (`signatureHeader`): every
 *   blob it names must be there, and each the import would read is read
 *   back and hashed first (`blobsProblem`); the signature must verify
 *   against the keys Grasp trusts (@grasp-os/shared/release-signature),
 *   and is stored at the manifest's hash; then a link is given for the
 *   manifest itself, which CI puts last. Already published as the
 *   commit's (a re-run after the manifest went up): that id. When anything
 *   else took the id first (finish answers 409, the link 412, or 409 once
 *   `releases/` is locked), the publish fails, and the next merge
 *   publishes: pushes to main run one at a time, so that needs a writer
 *   outside CI.
 *
 * A link is a presigned PUT of one object, for 15 minutes, with
 * `If-None-Match: *` and, where the manifest names the object's SHA-256
 * (modules, migrations, the manifest), `x-amz-checksum-sha256` among its
 * signed headers. R2 documents If-None-Match on PutObject and signed
 * headers on presigned URLs; that it refuses a presigned PUT whose signed
 * condition or checksum doesn't hold follows from SigV4 but isn't
 * documented, and R2's API page doesn't list the checksum headers for
 * PutObject. So nothing here relies on them: finish reads back what was
 * put, a static file's bytes included, before it gives the manifest's
 * link, and the import and every deploy hash the bytes again.
 *
 * The links are signed with an R2 key only the admin holds
 * (`RELEASE_UPLOAD_KEY`), in the account's Secrets Store, put there by
 * hand and never in 1Password or CI (scripts/optional-secrets.ts,
 * `handKeptSecrets`). Only staging's admin has it; production's answers
 * 404, as CI publishes to staging alone. The admin signs nothing: the
 * signing key is in no Cloudflare account (scripts/release/
 * sign-manifest.ts).
 *
 * What it gives a manifest's link for, it checks first: a release
 * manifest of the very commit GitHub says the run is building, under the
 * id this commit was given, this month's, not yet published, its blobs as
 * it names them, signed by a key Grasp trusts. Which manifest of that
 * commit CI sends it can't check: what CI's publish of main sends is
 * what's released. Each publish is audited (`release.publish`), with the
 * run that asked.
 *
 * Reached without Cloudflare Access: Access lets this one path through
 * (an application of its own, Bypass), and GitHub's token is the only
 * credential here. src/server.ts routes it before the Access check.
 */
import "@tanstack/react-start/server-only";
import { fromBase64Url, toBase64, toHex } from "@grasp-os/shared/encoding";
import { errorName, log } from "@grasp-os/shared/log";
import {
  platformR2Endpoint,
  releasesBucketName,
  stageNamed,
} from "@grasp-os/shared/names";
import {
  blobsOf,
  checkBlob,
  checksOf,
  commitKey,
  manifestKey,
  mapConcurrently,
  releaseManifestSchema,
  sha256OfBytes,
  storedBlobProblem,
  storedModelFileProblem,
} from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import {
  nextReleaseId,
  parsePublishedReleaseId,
  releaseIdSchema,
  releaseMonthPrefix,
} from "@grasp-os/shared/release-id";
import {
  releaseSignatureProblem,
  signatureKey,
} from "@grasp-os/shared/release-signature";
import { releaseSigningKeys } from "@grasp-os/shared/release-signing-keys";
import { AwsClient } from "aws4fetch";
import { inArray } from "drizzle-orm";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { auditEvents, releaseBlobs } from "../db/schema.ts";
import { optionalStoreSecret } from "../deploy/context.ts";
import { boundedBytes } from "../request-body.ts";
import { publishRunOf } from "./github-oidc.ts";
import type { PublishRun } from "./github-oidc.ts";
import { checkedBefore, MAX_MANIFEST_BYTES } from "./import.ts";

/** Where CI publishes. */
export const releasePublishPath = "/release-publish";

/** How long an upload link works: a publish uploads in about a minute. */
const LINK_SECONDS = 15 * 60;

/** Heads in flight at once: a Worker waits on at most six. */
const HEADS_AT_ONCE = 6;

/**
 * The header finish takes the manifest's signature file in, base64url:
 * the body is the manifest's exact bytes.
 */
export const signatureHeader = "x-release-signature";

/** The R2 key the links are signed with, as the store holds it. */
const uploadKeySchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

/** An upload link: a PUT of one object to `url`, with exactly `headers`. */
export interface UploadLink {
  key: string;
  url: string;
  headers: Record<string, string>;
}

const answer = (status: number, text: string): Response =>
  new Response(text, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain" },
  });

const json = (body: unknown): Response =>
  Response.json(body, { headers: { "cache-control": "no-store" } });

/** A JSON value of `text` that `schema` takes, or undefined. */
const parsedAs = <T>(schema: z.ZodType<T>, text: string): T | undefined => {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/** The manifest `bytes` hold, or undefined for anything else. */
const manifestIn = (bytes: Uint8Array): ReleaseManifest | undefined => {
  try {
    return releaseManifestSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    );
  } catch {
    return undefined;
  }
};

/** What CI's publish asks with: its run, the manifest, its signature if sent, and the link signer. */
interface Ask {
  run: PublishRun;
  bytes: Uint8Array<ArrayBuffer>;
  manifest: ReleaseManifest;
  signature: Uint8Array | undefined;
  links: (key: string, headers: Record<string, string>) => Promise<UploadLink>;
}

/** The signature file `request` carries (`signatureHeader`), or undefined. */
const signatureOf = (request: Request): Uint8Array | undefined => {
  const sent = request.headers.get(signatureHeader);
  if (sent === null) {
    return undefined;
  }
  try {
    return fromBase64Url(sent);
  } catch {
    return undefined;
  }
};

/** Signs upload links to the stage's releases bucket with `uploadKey`. */
const linkSigner = (
  uploadKey: z.infer<typeof uploadKeySchema>,
  bucket: string
) => {
  const client = new AwsClient({
    ...uploadKey,
    service: "s3",
    region: "auto",
  });
  return async (
    key: string,
    headers: Record<string, string>
  ): Promise<UploadLink> => {
    const url = new URL(`${platformR2Endpoint}/${bucket}/${key}`);
    url.searchParams.set("X-Amz-Expires", String(LINK_SECONDS));
    // Every header signed: R2 refuses a PUT without exactly these.
    const signed = await client.sign(
      new Request(url, { method: "PUT", headers }),
      { aws: { signQuery: true, allHeaders: true } }
    );
    return { key, url: signed.url, headers };
  };
};

/** Base64 of the SHA-256 hex `sha256`: R2's `x-amz-checksum-sha256`. */
const checksumOf = (sha256: string): string =>
  toBase64(
    Uint8Array.from(sha256.match(/../gu) ?? [], (pair) =>
      Number.parseInt(pair, 16)
    )
  );

/** The headers a link for a blob or the manifest carries: absent only, and its SHA-256 when known. */
const putHeaders = (
  sha256: string | undefined,
  contentType?: string
): Record<string, string> => ({
  "if-none-match": "*",
  ...(sha256 === undefined
    ? {}
    : { "x-amz-checksum-sha256": checksumOf(sha256) }),
  ...(contentType === undefined ? {} : { "content-type": contentType }),
});

/** Every id with anything under `releases/` this month, by a listing of the month. */
const monthIds = async (bucket: R2Bucket, now: Date): Promise<string[]> => {
  const prefix = `releases/${releaseMonthPrefix(now)}`;
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const page = await bucket.list({
      prefix,
      delimiter: "/",
      ...(cursor === undefined ? {} : { cursor }),
    });
    ids.push(
      ...page.delimitedPrefixes.map((each) =>
        each.slice("releases/".length, -1)
      )
    );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return ids;
};

/**
 * The commit's release as the bucket has it: the id its marker names, and
 * whether that id's manifest is the commit's (published) or isn't there
 * yet (open); undefined when there's no marker, or its id went to another
 * release.
 */
const markedRelease = async (
  bucket: R2Bucket,
  commit: string
): Promise<{ id: string; published: boolean } | undefined> => {
  const marker = await bucket.get(commitKey(commit));
  const named = marker === null ? undefined : await marker.text();
  const id = releaseIdSchema.safeParse(named?.trim());
  if (!id.success || parsePublishedReleaseId(id.data) === undefined) {
    return undefined;
  }
  const stored = await bucket.get(manifestKey(id.data));
  if (stored === null) {
    return { id: id.data, published: false };
  }
  const manifest = manifestIn(new Uint8Array(await stored.arrayBuffer()));
  return manifest?.commit === commit && manifest.releaseId === id.data
    ? { id: id.data, published: true }
    : undefined;
};

/** What R2 reports of the object at `key`: its size and SHA-256 (hex), if kept. */
const stored = async (bucket: R2Bucket, key: string) => {
  const head = await bucket.head(key);
  if (head === null) {
    return null;
  }
  const { sha256 } = head.checksums;
  return {
    size: head.size,
    ...(sha256 === undefined ? {} : { sha256: toHex(new Uint8Array(sha256)) }),
  };
};

/** Whether release id `id` is of `now`'s month, as CI's publish claims ids. */
const isThisMonths = (id: string, now: Date): boolean =>
  id.startsWith(releaseMonthPrefix(now));

/** Keys looked up in one statement: D1 binds at most 100 values. */
const KEYS_PER_LOOKUP = 50;

/**
 * Of `keys`, those a release the admin imported, or is importing, names
 * (`release_blobs`, src/releases/blobs.ts): blobs a signed release relies
 * on, never deleted here on a new manifest's word.
 */
const namedByReleases = async (
  db: AdminDatabase,
  keys: readonly string[]
): Promise<Set<string>> => {
  const named = new Set<string>();
  for (let at = 0; at < keys.length; at += KEYS_PER_LOOKUP) {
    // oxlint-disable-next-line no-await-in-loop -- a page of keys at a time
    const rows = await db
      .selectDistinct({ key: releaseBlobs.blobKey })
      .from(releaseBlobs)
      .where(
        inArray(releaseBlobs.blobKey, keys.slice(at, at + KEYS_PER_LOOKUP))
      );
    for (const { key } of rows) {
      named.add(key);
    }
  }
  return named;
};

/** Blobs read back at once at finish: the largest is 25 MiB, held with its base64. */
const READS_AT_ONCE = 2;

/**
 * Why the bucket doesn't hold `manifest`'s blobs as it names them;
 * undefined when it does. Each must be there; and each the import would
 * read whole (one the newest imported release didn't check the same way,
 * `checkedBefore`: whatever this publish's links put, and anything a
 * leaked link or an interrupted run left) is read back and hashed first
 * (`checkBlob`), so no link, nor CI, gets other bytes signed for. One
 * that doesn't match is deleted, so the next start gives a link for it
 * again, and nothing left behind wedges publishing; unless a release the
 * admin imported names it (`namedByReleases`): then the manifest is what's
 * wrong, and the blob stays.
 */
const blobsProblem = async (
  bucket: R2Bucket,
  db: AdminDatabase,
  manifest: ReleaseManifest
): Promise<string | undefined> => {
  const before = await checkedBefore(db);
  const kept = await namedByReleases(
    db,
    blobsOf(manifest).map(({ key }) => key)
  );
  const heads = await mapConcurrently(
    blobsOf(manifest),
    HEADS_AT_ONCE,
    async (blob) => ({ blob, head: await bucket.head(blob.key) })
  );
  const missing = heads.find(({ head }) => head === null);
  if (missing !== undefined) {
    return `${missing.blob.key} is missing`;
  }
  const failures = await mapConcurrently(
    heads.filter(({ blob }) =>
      checksOf(blob).some((check) => before.get(blob.key)?.has(check) !== true)
    ),
    READS_AT_ONCE,
    async ({ blob }): Promise<string | undefined> => {
      const object = await bucket.get(blob.key);
      const bytes =
        object === null
          ? undefined
          : new Uint8Array(await object.arrayBuffer());
      let failure: string | undefined;
      try {
        await checkBlob(blob, bytes);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (failure !== undefined && !kept.has(blob.key)) {
        await bucket.delete(blob.key);
      }
      return failure;
    }
  );
  return failures.find((failure) => failure !== undefined);
};

/** `?step=start`: the release's id, and links for the blobs the bucket lacks. */
const start = async (env: Env, ask: Ask): Promise<Response> => {
  const { manifest } = ask;
  for (const file of manifest.modelFiles) {
    // oxlint-disable-next-line no-await-in-loop -- a few files
    const head = await stored(env.RELEASES, file.r2Key);
    const problem = storedModelFileProblem(file, head);
    if (problem !== undefined) {
      return answer(
        409,
        `Model file ${file.name} at ${file.r2Key} ${problem}: put it there with release:model-files`
      );
    }
  }
  const marked = await markedRelease(env.RELEASES, manifest.commit);
  if (marked?.published === true) {
    return json({ publishedAs: marked.id });
  }
  const now = new Date();
  const held = await mapConcurrently(
    blobsOf(manifest),
    HEADS_AT_ONCE,
    async (blob) => ({ blob, head: await stored(env.RELEASES, blob.key) })
  );
  // One stored at another size, or SHA-256, than the manifest names (left
  // by an interrupted run or a leaked link) goes, and gets a link again;
  // never one a release the admin imported names, on a new manifest's word.
  const wrong = held.filter(
    ({ blob, head }) =>
      head !== null && storedBlobProblem(blob, head) !== undefined
  );
  const kept = await namedByReleases(
    adminDatabase(env.DB),
    wrong.map(({ blob }) => blob.key)
  );
  const disputed = wrong.find(({ blob }) => kept.has(blob.key));
  if (disputed !== undefined) {
    return answer(
      409,
      `${disputed.blob.key} is an imported release's, and isn't what this manifest says`
    );
  }
  await Promise.all(
    wrong.map(async ({ blob }) => {
      await env.RELEASES.delete(blob.key);
    })
  );
  const lacking = [...held.filter(({ head }) => head === null), ...wrong].map(
    ({ blob }) => blob
  );
  // Its marked id while that's open and this month's; across a month's
  // end, the new month's next, so an id of a month gone is never given a
  // manifest's link.
  let id = marked?.id;
  if (id === undefined || !isThisMonths(id, now)) {
    id = nextReleaseId(await monthIds(env.RELEASES, now), now);
    await env.RELEASES.put(commitKey(manifest.commit), `${id}\n`);
  }
  const uploads = await Promise.all(
    lacking.map(async (blob) => {
      const [sha256] = blob.expectations.flatMap((expectation) =>
        expectation.kind === "file" ? [expectation.sha256] : []
      );
      return await ask.links(blob.key, putHeaders(sha256));
    })
  );
  return json({ id, uploads });
};

/**
 * `?step=finish`: the stamped manifest's blobs read back and its
 * signature checked and stored, and the link for the manifest.
 */
const finish = async (env: Env, ask: Ask): Promise<Response> => {
  const { manifest, bytes } = ask;
  const marked = await markedRelease(env.RELEASES, manifest.commit);
  if (marked === undefined || marked.id !== manifest.releaseId) {
    return answer(
      409,
      `Release ${manifest.releaseId} isn't the id commit ${manifest.commit}'s publish was given`
    );
  }
  if (marked.published) {
    return json({ publishedAs: marked.id });
  }
  if (!isThisMonths(manifest.releaseId, new Date())) {
    return answer(
      409,
      `Release ${manifest.releaseId} isn't this month's: publish again`
    );
  }
  const unsigned = await releaseSignatureProblem(
    bytes,
    ask.signature,
    releaseSigningKeys
  );
  if (unsigned !== undefined || ask.signature === undefined) {
    return answer(
      400,
      `Release ${manifest.releaseId} ${unsigned ?? "isn't signed"}`
    );
  }
  const problem = await blobsProblem(
    env.RELEASES,
    adminDatabase(env.DB),
    manifest
  );
  if (problem !== undefined) {
    return answer(409, `${problem}: publish again`);
  }
  const manifestSha256 = await sha256OfBytes(bytes);
  const at = signatureKey(manifestSha256);
  // The same manifest signs the same each time: one there already stands.
  if ((await env.RELEASES.head(at)) === null) {
    await env.RELEASES.put(at, ask.signature);
  }
  await adminDatabase(env.DB)
    .insert(auditEvents)
    .values({
      id: crypto.randomUUID(),
      at: new Date(),
      actor: "system",
      action: "release.publish",
      target: manifest.releaseId,
      detail: JSON.stringify({
        commit: manifest.commit,
        manifestSha256,
        run: ask.run.runId,
        attempt: ask.run.runAttempt,
      }),
    });
  return json({
    upload: await ask.links(
      manifestKey(manifest.releaseId),
      putHeaders(manifestSha256, "application/json")
    ),
  });
};

const steps = { start, finish } as const;

const answered = async (request: Request, env: Env): Promise<Response> => {
  const step = new URL(request.url).searchParams.get("step");
  if (request.method !== "POST" || (step !== "start" && step !== "finish")) {
    return answer(405, "POST a manifest to ?step=start or ?step=finish");
  }
  const storedUploadKey = await optionalStoreSecret(env, "RELEASE_UPLOAD_KEY");
  const stage = stageNamed(env.STAGE);
  if (storedUploadKey === undefined || stage === undefined) {
    return answer(404, "This admin takes no releases");
  }
  const run = await publishRunOf(request, env.STAGE);
  if (run === null) {
    return answer(403, "Only CI's publish of a release on main may ask");
  }
  const bytes = await boundedBytes(request, MAX_MANIFEST_BYTES);
  if (bytes === undefined) {
    return answer(413, `A manifest is at most ${MAX_MANIFEST_BYTES} bytes`);
  }
  const manifest = manifestIn(bytes);
  if (manifest === undefined) {
    return answer(400, "Not a release manifest");
  }
  if (manifest.commit !== run.commit) {
    return answer(
      403,
      `The manifest is commit ${manifest.commit}'s; this run builds ${run.commit}`
    );
  }
  const uploadKey = parsedAs(uploadKeySchema, storedUploadKey);
  if (uploadKey === undefined) {
    log.error("release.publish_key_unusable", {});
    return answer(503, "The admin's release upload key isn't usable");
  }
  return await steps[step](env, {
    run,
    bytes,
    manifest,
    signature: signatureOf(request),
    links: linkSigner(uploadKey, releasesBucketName(stage)),
  });
};

/**
 * Answers a request to `releasePublishPath`. What may pass (GitHub's keys,
 * the store or the bucket not answering) answers 503, which CI tries
 * again.
 */
export const publishRelease = async (
  request: Request,
  env: Env
): Promise<Response> => {
  try {
    return await answered(request, env);
  } catch (error) {
    log.error("release.publish_failed", { error: errorName(error) });
    return answer(503, "Couldn't answer now; try again");
  }
};
