import { uploadTypes } from "@grasp-os/shared/uploads";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { cleanupsPerPage } from "../src/knowledge-uploads.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { auditedDuring, openRpc, outcome, signedInApi } from "./sign-in.ts";

// The files once uploaded into Knowledge, which is gone (GRA-1941): core's
// rows of them and their originals in R2 (src/knowledge-uploads.ts). A
// person's erasure forgets every one they made, wherever they made it,
// and deletes the originals before its `brain` area reads as complete.
// Nothing uploads into Knowledge any more; the uploads here are as those
// uploads left them.

const idp = mockIdp();

/** An upload's original in R2, as uploads into Knowledge stored it. */
const originalKey = (collectionId: string, uploadId: string): string =>
  `knowledge/${collectionId}/${uploadId}`;

/** Whether core still holds the upload `uploadId`. */
const uploadKept = async (uploadId: string): Promise<boolean> =>
  (await env.DB.prepare("SELECT 1 FROM uploads WHERE id = ?")
    .bind(uploadId)
    .first()) !== null;

/** An upload as uploads into Knowledge left one, with its collection. */
interface Left {
  collectionId: string;
  uploadId: string;
}

/** How an upload into Knowledge was left: its state. */
interface LeftAs {
  path: string;
  status: "pending" | "extracting" | "saving" | "ready" | "failed";
}

/**
 * An upload by `person` into `collectionId` as uploads into Knowledge left
 * it, its original stored in R2.
 */
const leftUpload = async (
  person: { userId: string },
  collectionId: string,
  { path, status }: LeftAs
): Promise<Left> => {
  const uploadId = crypto.randomUUID();
  const at = Date.now();
  const bytes = new TextEncoder().encode(`The file ${path}`);
  await env.FILES.put(originalKey(collectionId, uploadId), bytes);
  await env.DB.prepare(
    `INSERT INTO uploads (id, collection_id, path, media_type, bytes, sha256,
       uploaded_by, actor, status, document_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
  )
    .bind(
      uploadId,
      collectionId,
      path,
      uploadTypes.xlsx,
      bytes.length,
      "0".repeat(64),
      person.userId,
      JSON.stringify({ type: "person", userId: person.userId }),
      status,
      at,
      at
    )
    .run();
  return { collectionId, uploadId };
};

/** How many of `uploads`' originals R2 still holds. */
const storedOf = async (uploads: readonly Left[]): Promise<number> => {
  const stored = await Promise.all(
    uploads.map(
      async ({ collectionId, uploadId }) =>
        (await env.FILES.head(originalKey(collectionId, uploadId))) !== null
    )
  );
  return stored.filter(Boolean).length;
};

/** How many of `uploads` core still holds. */
const keptOf = async (uploads: readonly Left[]): Promise<number> => {
  const kept = await Promise.all(
    uploads.map(async ({ uploadId }) => await uploadKept(uploadId))
  );
  return kept.filter(Boolean).length;
};

/** Where the `brain` area of `userId`'s erasure stands. */
const brainArea = async (userId: string) =>
  await env.DB.prepare(
    "SELECT state FROM person_erasure_areas WHERE user_id = ? AND area = 'brain'"
  )
    .bind(userId)
    .first<{ state: string }>();

/** R2's `FILES`, refusing every delete, as when it is out of reach. */
const refusingDeletes = (): R2Bucket =>
  new Proxy(env.FILES, {
    get: (target, property) => {
      if (property === "delete") {
        return async () => {
          await Promise.resolve();
          throw new Error("R2 is out of reach");
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });

/** Uploads more than one page of the cleanup's. */
const manyUploads = cleanupsPerPage + 1;

describe("the files a person once uploaded into Knowledge, as they are erased", () => {
  it("are forgotten wherever they uploaded them, their originals deleted, another's kept, and counted on the erasure's record", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const other = await signedInApi(idp, "user");
    const own = crypto.randomUUID();
    const shared = crypto.randomUUID();
    const theirs = [
      await leftUpload(person, own, { path: "Mine.xlsx", status: "ready" }),
      await leftUpload(person, shared, { path: "Team.xlsx", status: "ready" }),
      await leftUpload(person, own, { path: "Cut.xlsx", status: "saving" }),
    ];
    const kept = await leftUpload(other, shared, {
      path: "Theirs.xlsx",
      status: "ready",
    });
    await admin.api.members.remove(person.userId);

    let erased: Awaited<ReturnType<typeof admin.api.members.erase>> | undefined;
    const events = await auditedDuring(async () => {
      erased = await admin.api.members.erase(
        person.userId,
        String(person.person.name)
      );
    });

    expect({
      done: typeof erased?.completedAt,
      stored: await storedOf(theirs),
      kept: await keptOf(theirs),
      another: [await storedOf([kept]), await keptOf([kept])],
      recorded: events
        .filter(({ action }) => action === "member.erasure.requested")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      done: "string",
      stored: 0,
      kept: 0,
      another: [1, 1],
      recorded: [{ userId: person.userId, knowledgeUploads: 3 }],
    });
  });

  it("deletes every original, however many", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const collectionId = crypto.randomUUID();
    const many = await Promise.all(
      Array.from(
        { length: manyUploads },
        async (_, n) =>
          await leftUpload(person, collectionId, {
            path: `File ${n}.xlsx`,
            status: "ready",
          })
      )
    );
    await admin.api.members.remove(person.userId);

    await admin.api.members.erase(person.userId, String(person.person.name));

    expect({
      stored: await storedOf(many),
      kept: await keptOf(many),
    }).toStrictEqual({ stored: 0, kept: 0 });
  });

  it("keeps the erasure pending while R2 refuses to delete an original, and finishes it at the clock's next run", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const collectionId = crypto.randomUUID();
    const theirs = [
      await leftUpload(person, collectionId, {
        path: "One.xlsx",
        status: "ready",
      }),
      await leftUpload(person, collectionId, {
        path: "Two.xlsx",
        status: "failed",
      }),
    ];
    await admin.api.members.remove(person.userId);
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, FILES: refusingDeletes() },
    });
    let failed: string;
    try {
      failed = await outcome(
        core
          .authenticate()
          .members.erase(person.userId, String(person.person.name))
      );
    } finally {
      core[Symbol.dispose]();
    }
    const whileRefused = {
      area: await brainArea(person.userId),
      stored: await storedOf(theirs),
    };

    await runMinuteTasks();

    expect({
      erase: failed,
      whileRefused,
      area: await brainArea(person.userId),
      stored: await storedOf(theirs),
      kept: await keptOf(theirs),
    }).toStrictEqual({
      erase: "ok",
      whileRefused: { area: { state: "pending" }, stored: 2 },
      area: { state: "complete" },
      stored: 0,
      kept: 0,
    });
  });
});

describe("uploads into Knowledge whose originals were deleted with Knowledge", () => {
  it("are still forgotten by a person's erasure, without a failure", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const collectionId = crypto.randomUUID();
    const theirs = await leftUpload(person, collectionId, {
      path: "Gone.xlsx",
      status: "ready",
    });
    // The account's deletion of `knowledge/` in the files bucket, as the
    // cutover's last step asks: the row stays, pointing at nothing.
    await env.FILES.delete(originalKey(collectionId, theirs.uploadId));
    await admin.api.members.remove(person.userId);

    const erased = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );

    expect({
      done: typeof erased.completedAt,
      area: await brainArea(person.userId),
      kept: await keptOf([theirs]),
      cleanups: await env.DB.prepare(
        "SELECT count(*) AS count FROM upload_cleanups WHERE upload_id = ?"
      )
        .bind(theirs.uploadId)
        .first<{ count: number }>(),
    }).toStrictEqual({
      done: "string",
      area: { state: "complete" },
      kept: 0,
      cleanups: { count: 0 },
    });
  });
});
