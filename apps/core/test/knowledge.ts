import { sha256Hex } from "@grasp-os/shared/encoding";
import type { CollectionInput, KnowledgeApi } from "@grasp-os/shared/knowledge";
import type {
  PermissionRequest,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { callAuth, unique } from "./sign-in.ts";

const insertsVersion = /^insert into "versions"/iu;

/**
 * The Knowledge database, but running `first` once, just before the first
 * batch that writes a version: another writer that gets there first.
 */
export const knowledgeRacing = (first: () => Promise<void>): D1Database => {
  const real = env.KNOWLEDGE;
  let writing = false;
  let raced = false;
  return {
    prepare: (query) => {
      writing ||= insertsVersion.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (writing && !raced) {
        raced = true;
        await first();
      }
      return await real.batch<T>(statements);
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/** A new team with `members`, made by an admin; returns its ID. */
export const newTeam = async (
  admin: { session: string },
  members: { userId: string }[]
): Promise<string> => {
  const created = await callAuth("/organization/create-team", admin.session, {
    name: `Team ${unique()}`,
  });
  const { id } = z.object({ id: z.string() }).parse(await created.json());
  for (const member of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    const added = await callAuth(
      "/organization/add-team-member",
      admin.session,
      {
        teamId: id,
        userId: member.userId,
      }
    );
    if (!added.ok) {
      throw new Error(`Adding ${member.userId} to the team failed`);
    }
  }
  return id;
};

/** A collection with one document, `note.md`, that links to itself. */
export const collectionWithNote = async (
  owner: { knowledge: KnowledgeApi },
  input: CollectionInput
) => {
  const collection = await owner.knowledge.createCollection(input);
  const note = await owner.knowledge.saveDocument({
    collectionId: collection.id,
    path: "note.md",
    text: "# Note\nSee [[note.md]] and [[other.md]].",
    ifVersion: 0,
  });
  await owner.knowledge.saveDocument({
    collectionId: collection.id,
    path: "other.md",
    text: "# Other\nBack to [[note.md]].",
    ifVersion: 0,
  });
  return { collectionId: collection.id, noteId: note.id };
};

/** A permission to read a collection, under `binding`. */
export const readCollection = (
  subject: PermissionSubjectInput,
  collectionId: string,
  binding = "HANDBOOK"
): PermissionRequest => ({
  subject,
  object: { type: "collection", collectionId },
  actions: ["read"],
  binding,
});

/**
 * A permission stored as it is, past the checks a request and a grant
 * make, as a bug or an old record could leave one: active by default, for
 * the reads and calls to refuse what it shouldn't allow on their own, or
 * requested, for a grant to refuse. Returns its ID.
 */
export const storedGrant = async (
  subject: { type: "app" | "agent"; id: string },
  object: { type: "collection" | "connection"; id: string },
  actions: string[],
  binding: string,
  status: "active" | "requested" = "active"
): Promise<string> => {
  const id = crypto.randomUUID();
  const grantedBy = status === "active" ? "test" : null;
  const grantedAt = status === "active" ? 0 : null;
  await env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
      actions, binding, status, requested_by, requested_at, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', 0, ?, ?)`
  )
    .bind(
      id,
      subject.type,
      subject.id,
      object.type,
      object.id,
      JSON.stringify(actions),
      binding,
      status,
      grantedBy,
      grantedAt
    )
    .run();
  return id;
};

/** The text of `key`'s object in the Brain bucket, as stored. */
const objectText = async (key: string): Promise<string> => {
  const object = await env.BRAIN_OBJECTS.get(key);
  if (object === null) {
    throw new Error(`no object ${key}`);
  }
  return await object.text();
};

/**
 * The text of every version of `documentId`, oldest first, as stored: each
 * version's payload, read from R2 whoever may read it.
 */
export const storedVersionTexts = async (
  documentId: string
): Promise<string[]> => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT payload_key AS key FROM versions WHERE document_id = ? ORDER BY number"
  )
    .bind(documentId)
    .all<{ key: string }>();
  return await Promise.all(
    results.map(async ({ key }) => await objectText(key))
  );
};

/** Each current text of `collectionId`'s documents, by path, as stored. */
export const storedCurrentTexts = async (
  collectionId: string
): Promise<Record<string, string>> => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT d.path AS path, v.payload_key AS key FROM documents d JOIN versions v ON v.document_id = d.id AND v.number = d.current_version WHERE d.collection_id = ?"
  )
    .bind(collectionId)
    .all<{ path: string; key: string }>();
  return Object.fromEntries(
    await Promise.all(
      results.map(async ({ path, key }): Promise<[string, string]> => [
        path,
        await objectText(key),
      ])
    )
  );
};

/**
 * Stores `text` as every version of `documentId` holds it, under the
 * platform's back: a text no save of this release would write.
 */
export const storeTextUnderneath = async (
  documentId: string,
  text: string
): Promise<D1PreparedStatement[]> => {
  const sha256 = await sha256Hex(text);
  const key = `payloads/${sha256}/${crypto.randomUUID()}`;
  await env.BRAIN_OBJECTS.put(key, text);
  return [
    env.KNOWLEDGE.prepare(
      "INSERT INTO brain_payloads (key, sha256, bytes, state, created_at) VALUES (?, ?, ?, 'committed', ?)"
    ).bind(key, sha256, new TextEncoder().encode(text).byteLength, Date.now()),
    env.KNOWLEDGE.prepare(
      "UPDATE versions SET payload_key = ? WHERE document_id = ?"
    ).bind(key, documentId),
  ];
};
