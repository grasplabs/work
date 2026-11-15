import type { PurgeInput, KnowledgeApi } from "@grasp-os/shared/knowledge";
import { uploadTypes } from "@grasp-os/shared/uploads";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { erasing } from "./knowledge-purge.ts";
import { ownCollectionOf } from "./knowledge.ts";
import { openRpc, outcome, signedInApi, unique } from "./sign-in.ts";

// A Knowledge purge and the files once uploaded into Knowledge: the
// originals of the files a purged document was saved from hold its data
// too, so the purge forgets their uploads and deletes the originals from
// R2. Nothing uploads into Knowledge any more; the uploads here are as
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

/**
 * A document in `collectionId` saved from a file uploaded into Knowledge,
 * as such an upload left it: the document holding `text`, the upload
 * ready, its original stored.
 */
const savedFromUpload = async (
  person: { userId: string; api: { knowledge: KnowledgeApi } },
  collectionId: string,
  text: string
): Promise<{ uploadId: string; documentId: string }> => {
  const path = `Offices ${unique()}.xlsx`;
  const saved = await person.api.knowledge.saveDocument({
    collectionId,
    path,
    text,
    ifVersion: 0,
  });
  const uploadId = crypto.randomUUID();
  const bytes = new TextEncoder().encode(text);
  await env.FILES.put(originalKey(collectionId, uploadId), bytes);
  const at = Date.now() - 60 * 60_000;
  await env.DB.prepare(
    `INSERT INTO uploads (id, collection_id, path, media_type, bytes, sha256,
       uploaded_by, actor, status, document_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, 1, ?, ?)`
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
      saved.id,
      at,
      at
    )
    .run();
  return { uploadId, documentId: saved.id };
};

describe("a Knowledge purge of documents saved from uploads", () => {
  it("deletes the original of a document it rewrites", async () => {
    const admin = await signedInApi(idp, "admin");
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "everyone",
    });
    const { uploadId, documentId } = await savedFromUpload(
      admin,
      collectionId,
      "# Contacts\nfacilities@example.com looks after upkeep."
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [documentId],
      terms: ["facilities@example.com"],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    const result = await admin.api.knowledge.purge(input, plan.token);

    expect({
      planned: [plan.documents, plan.originals],
      rewritten: result.documents,
      stored: await originalStored(collectionId, uploadId),
      kept: await uploadKept(uploadId),
    }).toStrictEqual({
      planned: [1, 1],
      rewritten: 1,
      stored: false,
      kept: false,
    });
  });

  it("deletes a document's originals in a content purge that finds nothing in its text", async () => {
    const admin = await signedInApi(idp, "admin");
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "everyone",
    });
    const { uploadId, documentId } = await savedFromUpload(
      admin,
      collectionId,
      "# Offices\nUtrecht and Ghent."
    );
    // Only in the file, where extraction never read it: an image, say.
    const input: PurgeInput = {
      type: "content",
      documentIds: [documentId],
      terms: ["Zanzibar"],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    const result = await admin.api.knowledge.purge(input, plan.token);

    expect({
      planned: [plan.documents, plan.originals],
      rewritten: result.documents,
      stored: await originalStored(collectionId, uploadId),
      kept: await uploadKept(uploadId),
    }).toStrictEqual({
      planned: [0, 1],
      rewritten: 0,
      stored: false,
      kept: false,
    });
  });

  it("deletes the originals in a collection only its owner reads once that person is purged", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const personal = await ownCollectionOf(person);
    const { uploadId } = await savedFromUpload(
      person,
      personal,
      "# Offices\nUtrecht and Ghent."
    );
    const input: PurgeInput = {
      type: "personal",
      userId: person.userId,
      reason: "offboarding",
    };
    await erasing(admin, person.userId);
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);

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
    const input: PurgeInput = {
      type: "personal",
      userId: person.userId,
      reason: "offboarding",
    };
    await erasing(admin, person.userId);
    const { token } = await admin.api.knowledge.preparePurge(input);
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
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, KNOWLEDGE: refusing },
    });
    let failed = "";
    try {
      failed = await outcome(core.authenticate().knowledge.purge(input, token));
    } finally {
      core[Symbol.dispose]();
    }
    const recorded = await vi.waitFor(
      async () => {
        const events = await allEvents();
        const purged = events.filter(
          (event) =>
            event.action === "knowledge.purged" &&
            event.detail.userId === person.userId
        );
        if (purged.length === 0) {
          throw new Error("Not recorded yet");
        }
        return purged.length;
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
});
