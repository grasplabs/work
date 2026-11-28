/**
 * Publishes a built release (build-release.ts) to staging's releases
 * bucket, as CI does with each merge, holding no key to the bucket: the
 * staging admin, once GitHub vouches for the run, gives it the release's
 * id, a link for each blob the bucket lacks, and, once the manifest
 * stamped with that id is signed, the manifest's own link
 * (publisher-lib.ts, apps/admin/src/releases/publish.ts). Each link puts
 * one object, only if absent, within 15 minutes.
 *
 * Two steps, each a CI job of its own, with the signing between them in a
 * job that runs none of this code (sign-manifest.ts, sign-release in
 * .github/workflows/ci.yml):
 *
 * - `stage` (stage-release): verifies the release against its manifest,
 *   the bytes that were hashed being the bytes sent; asks the admin for
 *   its id and links; uploads the blobs; and writes the manifest stamped
 *   with the id to the file `--out` names. A commit already published
 *   stages nothing. A blob another writer stored since the admin looked
 *   is left as it is: the admin reads it back at finish.
 * - `finish` (publish-release): sends the stamped manifest, with the
 *   signature sign-release wrote beside it, to the admin, which checks
 *   both and the blobs, and puts the manifest by the link it gives, last:
 *   the admin imports only releases whose manifest exists, so a publish
 *   that stops halfway never leaves a manifest pointing at missing blobs.
 *   When anything took the id first (the admin answers 409, the link 412,
 *   or 409 once `releases/` is locked), nothing is published and it
 *   fails: pushes to main run one at a time, and the next merge publishes.
 *
 * Each step publishes only while the commit is main's head (--head, which
 * CI asks GitHub for right before): a re-run of a push main has moved
 * past publishes nothing, rather than an older commit under a newer id.
 *
 * Env: as publisher-lib.ts
 * Usage: vp run release:publish stage --release <dir> --out <manifest file> --head <sha>
 *        vp run release:publish finish --manifest <manifest file> --head <sha>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { mapConcurrently } from "@grasp-os/shared/release";
import { RELEASE_SIGNATURE_FILE } from "@grasp-os/shared/release-signature";
import { z } from "zod";

import { stampReleaseId } from "./assign-lib.ts";
import { REQUESTS_AT_ONCE, sendWithRetries } from "./bucket-lib.ts";
import { verifyRelease } from "./manifest-lib.ts";
import { releasePublisherFromEnv } from "./publisher-lib.ts";
import type { UploadLink } from "./publisher-lib.ts";

const HTTP_CONFLICT = 409;
const HTTP_PRECONDITION_FAILED = 412;

const {
  positionals: [step],
  values: args,
} = parseArgs({
  allowPositionals: true,
  options: {
    release: { type: "string" },
    out: { type: "string" },
    manifest: { type: "string" },
    head: { type: "string" },
  },
});
if (args.head === undefined) {
  throw new Error("--head <main's head commit> is required");
}
const { head } = args;

/**
 * PUTs `bytes` by `link`: whether it stored them (false when the link's
 * object was there already: 412, or 409 from a bucket lock).
 */
const put = async (link: UploadLink, bytes: Buffer): Promise<boolean> => {
  const init = { method: "PUT", body: bytes, headers: link.headers };
  const answer = await sendWithRetries(
    `PUT ${link.key}`,
    init,
    async (signal) => await fetch(link.url, { ...init, signal })
  );
  if (answer.ok) {
    return true;
  }
  if (
    answer.status === HTTP_PRECONDITION_FAILED ||
    answer.status === HTTP_CONFLICT
  ) {
    return false;
  }
  throw new Error(
    `PUT ${link.key}: ${answer.status} ${await answer.text()}; nothing published`
  );
};

/** Says so and answers false unless `commit` is main's head. */
const isHead = (commit: string): boolean => {
  if (commit === head) {
    return true;
  }
  // Main has moved on since this run started: the newer push publishes
  // its own release, which carries this commit's changes.
  console.info(
    `::notice::Not publishing ${commit}: main's head is ${head} now, which publishes its own release`
  );
  return false;
};

/** `stage`: the release's id and blobs, and its manifest stamped with that id in `out`. */
const stage = async (releaseDir: string, out: string): Promise<void> => {
  const { manifest, manifestBytes, blobs } = await verifyRelease(
    path.resolve(releaseDir)
  );
  if (!isHead(manifest.commit)) {
    return;
  }
  const plan = await releasePublisherFromEnv().start(manifestBytes);
  if ("publishedAs" in plan) {
    console.warn(
      `::warning::${manifest.commit} is already published, as release ${plan.publishedAs}; nothing staged`
    );
    return;
  }
  const stored = await mapConcurrently(
    plan.uploads,
    REQUESTS_AT_ONCE,
    async (link) => {
      const bytes = blobs.get(link.key);
      if (bytes === undefined) {
        throw new Error(
          `The staging admin asked for ${link.key}, which the release doesn't carry; nothing published`
        );
      }
      return await put(link, bytes);
    }
  );
  const uploaded = stored.filter(Boolean).length;
  console.info(
    `Blobs: ${uploaded} uploaded, ${blobs.size - uploaded} already there`
  );
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, stampReleaseId(manifestBytes, plan.id).manifestBytes);
  console.info(`Staged release ${plan.id} of ${manifest.commit} in ${out}`);
};

const stampedManifest = z.object({ releaseId: z.string(), commit: z.string() });

/** `finish`: the signed manifest at `file` published under its id. */
const finish = async (file: string): Promise<void> => {
  const manifestBytes = readFileSync(file);
  const { releaseId, commit } = stampedManifest.parse(
    JSON.parse(manifestBytes.toString("utf-8"))
  );
  if (!isHead(commit)) {
    return;
  }
  const signature = readFileSync(
    path.join(path.dirname(file), RELEASE_SIGNATURE_FILE)
  );
  const publisher = releasePublisherFromEnv();
  const link = await publisher.finish(manifestBytes, signature);
  if ("publishedAs" in link) {
    console.warn(
      `::warning::${commit} is already published, as release ${link.publishedAs}; nothing published again`
    );
    return;
  }
  // Its link finding the manifest there already: an earlier try's whose
  // answer was lost, or another's. The admin knows which.
  const stored =
    (await put(link, manifestBytes)) ||
    "publishedAs" in (await publisher.finish(manifestBytes, signature));
  if (!stored) {
    throw new Error(
      `Release ${releaseId} was taken by another manifest meanwhile; nothing published, and the next merge publishes`
    );
  }
  console.info(`Published ${link.key}: release ${releaseId}`);
};

if (step === "stage" && args.release !== undefined && args.out !== undefined) {
  await stage(args.release, args.out);
} else if (step === "finish" && args.manifest !== undefined) {
  await finish(args.manifest);
} else {
  throw new Error(
    "Usage: publish-release.ts stage --release <dir> --out <file> --head <sha> | finish --manifest <file> --head <sha>"
  );
}
