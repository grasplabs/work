import { uploadTypes } from "@grasp-os/shared/uploads";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { cleanupsPerPage } from "../src/knowledge-uploads.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { openRpc, outcome, signedInApi } from "./sign-in.ts";

// The files once uploaded into Knowledge, which is gone (GRA-1941): core's
// rows of them and their originals in R2 (src/knowledge-uploads.ts). A
// person's erasure forgets every one they made, wherever they made it,
// and deletes the originals before its `brain` area reads as complete;
// the clock forgets those left unended. Nothing uploads into Knowledge any
// more; the uploads here are as those uploads left them.

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

/** How an upload into Knowledge was left: its state, and when it last changed. */
interface LeftAs {
  path: string;
  status: "pending" | "extracting" | "saving" | "ready" | "failed";
  /** When it was recorded and last changed: now, unless given. */
  at?: number;
}

/**
 * An upload by `person` into `collectionId` as uploads into Knowledge left
 * it, its original stored in R2.
 */
const leftUpload = async (
  person: { userId: string },
  collectionId: string,
  { path, status, at = Date.now() }: LeftAs
): Promise<Left> => {
  const uploadId = crypto.randomUUID();
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
  it("are forgotten wherever they uploaded them, their originals deleted, and another's kept", async () => {
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

    const erased = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );

    expect({
      done: typeof erased.completedAt,
      stored: await storedOf(theirs),
      kept: await keptOf(theirs),
      another: [await storedOf([kept]), await keptOf([kept])],
    }).toStrictEqual({ done: "string", stored: 0, kept: 0, another: [1, 1] });
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

describe("uploads into Knowledge left behind", () => {
  it("are forgotten by the clock once unchanged for a while, their originals deleted, a failure's recorded cleanup too, and tried again while R2 refuses", async () => {
    const admin = await signedInApi(idp, "admin");
    const collectionId = crypto.randomUUID();
    const anHourAgo = Date.now() - 60 * 60_000;
    const left = await Promise.all(
      (["pending", "extracting", "saving"] as const).map(
        async (status) =>
          await leftUpload(admin, collectionId, {
            path: `${status}.xlsx`,
            status,
            at: anHourAgo,
          })
      )
    );
    // Taken a moment ago by the release before, which may yet store its
    // original: left alone.
    const fresh = await leftUpload(admin, collectionId, {
      path: "Fresh.xlsx",
      status: "pending",
    });
    // A failure that recorded its original's delete, cut short before R2
    // deleted it.
    const failed = await leftUpload(admin, collectionId, {
      path: "Failed.xlsx",
      status: "failed",
      at: anHourAgo,
    });
    await env.DB.prepare(
      "INSERT INTO upload_cleanups (key, upload_id, created_at) VALUES (?, ?, ?)"
    )
      .bind(
        originalKey(collectionId, failed.uploadId),
        failed.uploadId,
        anHourAgo
      )
      .run();
    const swept = [...left, failed];
    await runMinuteTasks({ FILES: refusingDeletes() });
    const whileRefused = await storedOf(swept);
    await runMinuteTasks();

    expect({
      whileRefused,
      stored: await storedOf(swept),
      kept: await keptOf(left),
      fresh: [await keptOf([fresh]), await storedOf([fresh])],
    }).toStrictEqual({
      whileRefused: 4,
      stored: 0,
      kept: 0,
      fresh: [1, 1],
    });
  });
});
