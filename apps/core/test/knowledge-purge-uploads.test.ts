import type { KnowledgeApi } from "@grasp-os/shared/knowledge";
import { uploadTypes } from "@grasp-os/shared/uploads";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { cleanupsPerPage } from "../src/knowledge/uploads.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { purged } from "./knowledge-purge.ts";
import { ownCollectionOf } from "./knowledge.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// A person's purge from Knowledge, as their erasure runs it, and the files
// once uploaded into their own collections: the originals hold their data
// too, so the purge forgets their uploads and deletes the originals from
// R2 before it reports done. Nothing uploads into Knowledge any more; the uploads here are as
// those uploads left them, ready, with their originals stored.

const idp = mockIdp();

/** An upload's original in R2, as uploads into Knowledge stored it. */
const originalKey = (collectionId: string, uploadId: string): string =>
  `knowledge/${collectionId}/${uploadId}`;

/** Whether R2 holds the original of the upload `uploadId`. */
const originalStored = async (
  collectionId: string,
  uploadId: string
): Promise<boolean> =>
  (await env.FILES.head(originalKey(collectionId, uploadId))) !== null;

/** Whether core still holds the upload `uploadId`. */
const uploadKept = async (uploadId: string): Promise<boolean> =>
  (await env.DB.prepare("SELECT 1 FROM uploads WHERE id = ?")
    .bind(uploadId)
    .first()) !== null;

/** How an upload into Knowledge was left: its state, where it was saved, and when it last changed. */
interface LeftAs {
  path: string;
  status: "pending" | "extracting" | "saving" | "ready" | "failed";
  documentId: string | null;
  /** When it was recorded and last changed: now, as a purge meets it, unless given. */
  at?: number;
}

/**
 * An upload into `collectionId` as uploads into Knowledge left it, its
 * original stored in R2: its ID.
 */
const leftUpload = async (
  person: { userId: string },
  collectionId: string,
  { path, status, documentId, at = Date.now() }: LeftAs
): Promise<string> => {
  const uploadId = crypto.randomUUID();
  const bytes = new TextEncoder().encode(`The file ${path}`);
  await env.FILES.put(originalKey(collectionId, uploadId), bytes);
  await env.DB.prepare(
    `INSERT INTO uploads (id, collection_id, path, media_type, bytes, sha256,
       uploaded_by, actor, status, document_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      documentId,
      documentId === null ? null : 1,
      at,
      at
    )
    .run();
  return uploadId;
};

/**
 * A document in `collectionId` saved from a file uploaded into Knowledge,
 * as such an upload left it: the document holding `text`, the upload
 * ready, its original stored.
 */
const savedFromUpload = async (
  person: { userId: string; api: { knowledge: KnowledgeApi } },
  collectionId: string,
  text: string
): Promise<{ uploadId: string; documentId: string; path: string }> => {
  const path = `Offices ${unique()}.xlsx`;
  const saved = await person.api.knowledge.saveDocument({
    collectionId,
    path,
    text,
    ifVersion: 0,
  });
  const uploadId = await leftUpload(person, collectionId, {
    path,
    status: "ready",
    documentId: saved.id,
  });
  return { uploadId, documentId: saved.id, path };
};

/** How many of `uploadIds`' originals R2 still holds. */
const storedOf = async (
  collectionId: string,
  uploadIds: readonly string[]
): Promise<number> => {
  const stored = await Promise.all(
    uploadIds.map(async (id) => await originalStored(collectionId, id))
  );
  return stored.filter(Boolean).length;
};

/** Uploads more than one page of the cleanup's. */
const manyUploads = cleanupsPerPage + 1;

describe("a person's purge of the files they uploaded into Knowledge", () => {
  it("deletes the originals in a collection only its owner reads once that person is purged", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const personal = await ownCollectionOf(person);
    const { uploadId } = await savedFromUpload(
      person,
      personal,
      "# Offices\nUtrecht and Ghent."
    );
    await purged(admin, person.userId);

    expect({
      stored: await originalStored(personal, uploadId),
      kept: await uploadKept(uploadId),
    }).toStrictEqual({ stored: false, kept: false });
  });

  it("records a personal purge before its originals go, though its batch then fails", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const personal = await ownCollectionOf(person);
    const { uploadId } = await savedFromUpload(
      person,
      personal,
      "# Offices\nUtrecht and Ghent."
    );
    // Knowledge refusing the batch that deletes the collection, once the
    // originals are gone.
    const refusing = new Proxy(env.KNOWLEDGE, {
      get: (target, property) => {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const deleting = statements.some((statement) =>
              JSON.stringify(statement).includes(
                'delete from \\"collections\\"'
              )
            );
            if (deleting) {
              throw new Error("D1 is down for a moment");
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const failed = await outcome(
      purged(admin, person.userId, { ...env, KNOWLEDGE: refusing })
    );
    const recorded = await vi.waitFor(
      async () => {
        const events = await allEvents();
        const ran = events.filter(
          (event) =>
            event.action === "knowledge.purged" &&
            event.detail.userId === person.userId
        );
        if (ran.length === 0) {
          throw new Error("Not recorded yet");
        }
        return ran.length;
      },
      { timeout: 10_000, interval: 100 }
    );

    const { documents } = await person.api.knowledge.listDocuments(personal);

    expect({
      failed: failed !== "ok",
      recorded,
      stored: await originalStored(personal, uploadId),
      // The collection is still there: running the purge again ends it.
      listed: documents.length,
    }).toStrictEqual({ failed: true, recorded: 1, stored: false, listed: 1 });
  });

  it("deletes every original of a person's own collection, however many, when that person is purged", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const personal = await ownCollectionOf(person);
    const ids = await Promise.all(
      Array.from(
        { length: manyUploads },
        async (_, n) =>
          await leftUpload(person, personal, {
            path: `File ${n}.xlsx`,
            status: "ready",
            documentId: null,
          })
      )
    );
    await purged(admin, person.userId);

    expect({
      stored: await storedOf(personal, ids),
      kept: await Promise.all(ids.map(uploadKept)).then(
        (kept) => kept.filter(Boolean).length
      ),
    }).toStrictEqual({ stored: 0, kept: 0 });
  });

  it("fails while R2 refuses to delete an original, and deletes every one when it is run again", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const personal = await ownCollectionOf(person);
    const ids = [
      await leftUpload(person, personal, {
        path: "One.xlsx",
        status: "ready",
        documentId: null,
      }),
      await leftUpload(person, personal, {
        path: "Two.xlsx",
        status: "failed",
        documentId: null,
      }),
    ];
    // R2 refusing the purge's deletes, as when it is out of reach.
    const refusing = new Proxy(env.FILES, {
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
    const failed = await outcome(
      purged(admin, person.userId, { ...env, FILES: refusing })
    );
    const storedAfterFailure = await storedOf(personal, ids);
    await purged(admin, person.userId);

    expect({
      failed: failed !== "ok",
      storedAfterFailure,
      stored: await storedOf(personal, ids),
    }).toStrictEqual({ failed: true, storedAfterFailure: 2, stored: 0 });
  });

  it("forgets an upload left in the middle of its save, and deletes its original", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const collectionId = await ownCollectionOf(person);
    const { uploadId, path } = await savedFromUpload(
      person,
      collectionId,
      "# Offices\nUtrecht and Ghent."
    );
    // The same file uploaded again, its save cut short when uploads into
    // Knowledge stopped: nothing will ever finish it.
    const saving = await leftUpload(person, collectionId, {
      path,
      status: "saving",
      documentId: null,
    });
    const ran = await outcome(purged(admin, person.userId));

    expect({
      ran,
      stored: await storedOf(collectionId, [uploadId, saving]),
      kept: [await uploadKept(uploadId), await uploadKept(saving)],
    }).toStrictEqual({ ran: "ok", stored: 0, kept: [false, false] });
  });
});

describe("uploads into Knowledge left behind", () => {
  it("are forgotten by the clock once unchanged for a while, their originals deleted, a failure's recorded cleanup too, and tried again while R2 refuses", async () => {
    const admin = await signedInApi(idp, "admin");
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "everyone",
    });
    const anHourAgo = Date.now() - 60 * 60_000;
    const left = await Promise.all(
      (["pending", "extracting", "saving"] as const).map(
        async (status) =>
          await leftUpload(admin, collectionId, {
            path: `${status}.xlsx`,
            status,
            documentId: null,
            at: anHourAgo,
          })
      )
    );
    // Taken a moment ago by the release before, which may yet store its
    // original: left alone.
    const fresh = await leftUpload(admin, collectionId, {
      path: "Fresh.xlsx",
      status: "pending",
      documentId: null,
      at: Date.now(),
    });
    // A failure that recorded its original's delete, cut short before R2
    // deleted it.
    const failed = await leftUpload(admin, collectionId, {
      path: "Failed.xlsx",
      status: "failed",
      documentId: null,
      at: anHourAgo,
    });
    await env.DB.prepare(
      "INSERT INTO upload_cleanups (key, upload_id, created_at) VALUES (?, ?, ?)"
    )
      .bind(originalKey(collectionId, failed), failed, anHourAgo)
      .run();
    const swept = [...left, failed];
    const refusing = new Proxy(env.FILES, {
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
    await runMinuteTasks({ FILES: refusing });
    const whileRefused = await storedOf(collectionId, swept);
    await runMinuteTasks();

    expect({
      whileRefused,
      stored: await storedOf(collectionId, swept),
      kept: await Promise.all(left.map(uploadKept)),
      fresh: [await uploadKept(fresh), await storedOf(collectionId, [fresh])],
    }).toStrictEqual({
      whileRefused: 4,
      stored: 0,
      kept: [false, false, false],
      fresh: [true, 1],
    });
  });
});
