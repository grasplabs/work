import { ensureCollection } from "@grasp-os/brain/collections";
import type { CommandReceipt } from "@grasp-os/brain/contract";
import { writeVersion } from "@grasp-os/brain/documents";
import { runLinking, sourceKey } from "@grasp-os/brain/entities";
import type { DocumentSummary } from "@grasp-os/brain/knowledge";
import {
  memoriesProposeChange,
  memoriesPublish,
} from "@grasp-os/brain/memories";
import { collections } from "@grasp-os/brain/schema";
import { actorOf } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { Collection, KnowledgeApi } from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { collectionTeams } from "../src/db/core/schema.ts";
import type { Reader } from "../src/knowledge/access.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { callAuth, unique, whoami } from "./sign-in.ts";

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

/** Someone signed in: a session's API, or their session's cookie. */
type Signed = { whoami: () => Promise<Identity> } | { session: string };

/** Who `signed` is, as core knows them. */
const identityOf = async (signed: Signed): Promise<Identity> =>
  "whoami" in signed ? await signed.whoami() : await whoami(signed.session);

/** A collection a test plants, as a person once created one. */
export interface CollectionInput {
  name: string;
  description?: string;
  access: "me" | "teams" | "everyone";
  /** The teams that read it, for `teams` access. */
  teams?: string[];
  sensitive?: boolean;
}

/** A document's next version, as a test writes one. */
interface SeededSave {
  collectionId: string;
  path: string;
  text: string;
  ifVersion: number;
  message?: string;
}

/**
 * Knowledge written as `signed`, the way today's Brain kept it before
 * nothing in core wrote it any more (GRA-1911): straight through the
 * package, as content a deployment still holds. No rule of who may write
 * is checked: only what tests plant.
 */
export const seed = (signed: Signed) => ({
  /** A collection they own, with its teams in core's database. */
  createCollection: async (input: CollectionInput): Promise<Collection> => {
    const person = await identityOf(signed);
    const parsed = {
      description: "",
      teams: [],
      sensitive: false,
      ...input,
    };
    const row = {
      id: collectionIdSchema.parse(crypto.randomUUID()),
      name: parsed.name,
      description: parsed.description,
      owner: person.userId,
      access: parsed.access,
      sensitive: parsed.sensitive,
      source: "here" as const,
      createdAt: new Date(),
    };
    if (parsed.teams.length > 0) {
      await drizzle(env.DB)
        .insert(collectionTeams)
        .values(
          parsed.teams.map((teamId) => ({ collectionId: row.id, teamId }))
        );
    }
    await ensureCollection(brainOf(env), row, actorOf(person));
    return {
      ...row,
      teams: parsed.teams,
      createdAt: row.createdAt.toISOString(),
    };
  },
  /** A document's next version, or its first, by them. */
  saveDocument: async ({
    collectionId,
    path,
    text,
    ifVersion,
    message,
  }: SeededSave): Promise<DocumentSummary> => {
    const person = await identityOf(signed);
    const [collection] = await drizzle(env.KNOWLEDGE)
      .select()
      .from(collections)
      .where(eq(collections.id, collectionId));
    if (collection === undefined) {
      throw new Error(`There's no collection ${collectionId} to seed`);
    }
    return await writeVersion(
      brainOf(env),
      { actor: actorOf(person), userId: person.userId },
      {
        collection,
        path,
        text,
        ifVersion,
        message: message ?? null,
        restoredFrom: null,
      }
    );
  },
  /** A record they published into a shared scope, as today's Brain kept one. */
  memoriesPublish: async (
    input: unknown,
    options: unknown
  ): Promise<CommandReceipt> =>
    await memoriesPublish(
      brainOf(env),
      { type: "person", person: await identityOf(signed) },
      input,
      options
    ),
  /** A correction of one of their own records, as today's Brain kept one. */
  memoriesProposeChange: async (
    input: unknown,
    options: unknown
  ): Promise<CommandReceipt> =>
    await memoriesProposeChange(
      brainOf(env),
      { type: "person", person: await identityOf(signed) },
      input,
      options
    ),
});

/**
 * Links document `documentId`'s version 1 as the removed linking job did,
 * with an extractor that names `name` wherever the text does.
 */
export const linkedNaming = async (
  documentId: string,
  name: string
): Promise<void> => {
  const brain = brainOf(env);
  await runLinking(
    {
      ...brain,
      ports: {
        ...brain.ports,
        extractEntities: async (text) =>
          await Promise.resolve({
            entities: text.includes(name) ? [{ kind: "person", name }] : [],
          }),
      },
    },
    { source: sourceKey({ kind: "document", id: documentId }), version: 1 },
    { do: async (_name, _config, run) => await run() }
  );
};

/** The name of the collection `ownCollectionOf` keeps a person's notes in. */
const ownNotes = "Own notes";

/**
 * A collection only `person` reads, theirs (`seed`): the one named "Own notes" they made before, or a
 * new one. Returns its ID.
 */
export const ownCollectionOf = async (person: {
  userId: string;
  api: Signed & { knowledge: KnowledgeApi };
}): Promise<string> => {
  const listed = await person.api.knowledge.listCollections();
  const made = listed.find(
    ({ name, owner, access }) =>
      name === ownNotes && owner === person.userId && access === "me"
  );
  if (made !== undefined) {
    return made.id;
  }
  const { id } = await seed(person.api).createCollection({
    name: ownNotes,
    access: "me",
  });
  return id;
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
  owner: Signed,
  input: CollectionInput
) => {
  const collection = await seed(owner).createCollection(input);
  const note = await seed(owner).saveDocument({
    collectionId: collection.id,
    path: "note.md",
    text: "# Note\nSee [[note.md]] and [[other.md]].",
    ifVersion: 0,
  });
  await seed(owner).saveDocument({
    collectionId: collection.id,
    path: "other.md",
    text: "# Other\nBack to [[note.md]].",
    ifVersion: 0,
  });
  return { collectionId: collection.id, noteId: note.id };
};

/**
 * A permission stored as it is, past the checks a request and a grant
 * make, as a bug or an old record could leave one: active by default, for
 * the reads and calls to refuse what it shouldn't allow on their own, or
 * requested, for a grant to refuse. Returns its ID.
 */
export const storedGrant = async (
  subject: { type: "app" | "agent"; id: string },
  object: { type: "collection" | "connection" | "platform"; id: string },
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
      "INSERT INTO brain_payloads (key, collection_id, sha256, bytes, state, created_at) SELECT ?, collection_id, ?, ?, 'committed', ? FROM documents WHERE id = ?"
    ).bind(
      key,
      sha256,
      new TextEncoder().encode(text).byteLength,
      Date.now(),
      documentId
    ),
    env.KNOWLEDGE.prepare(
      "UPDATE versions SET payload_key = ? WHERE document_id = ?"
    ).bind(key, documentId),
  ];
};

/** `person`'s reader of Knowledge, as their own session's calls read it. */
export const asPerson = async (person: {
  api: { whoami: () => Promise<Identity> };
}): Promise<Reader> => ({ type: "person", person: await person.api.whoami() });
