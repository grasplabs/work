import { blobKeys } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import { recordBlobs } from "../src/releases/blobs.ts";
import { buildRelease, nextReleaseId } from "./releases.ts";

// Which blobs a release names (src/releases/blobs.ts), as the import and
// retention record them: every one, each once, in place of what a
// replaced manifest named.

const db = adminDatabase(env.DB);

/** The blobs on record for release `releaseId`, sorted. */
const recordedOf = async (releaseId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT blob_key AS key FROM release_blobs WHERE release_id = ?"
  )
    .bind(releaseId)
    .all<{ key: string }>();
  return results.map(({ key }) => key).toSorted();
};

describe("a release's blobs on record", () => {
  it("records every blob a manifest names, once each, in place of those a replaced manifest named", async () => {
    const id = nextReleaseId();
    const replaced = await buildRelease(
      {
        notes: "Broken upload",
        modelFiles: { "old-1": "old 1", "old-2": "old 2" },
      },
      id
    );
    // More blobs than one statement of D1's 100 bound parameters names one
    // by one, one of them named twice.
    const models = Object.fromEntries(
      Array.from({ length: 150 }, (_, at) => [`model-${at}`, `model ${at}`])
    );
    const manifest = await buildRelease(
      { notes: "Put right", modelFiles: { ...models, again: "model 3" } },
      id
    );

    await recordBlobs(db, id, replaced.manifest);
    await recordBlobs(db, id, manifest.manifest);

    await expect(recordedOf(id)).resolves.toStrictEqual(
      [...new Set(blobKeys(manifest.manifest))].toSorted()
    );
  });
});
