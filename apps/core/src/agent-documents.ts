import { agentErrors } from "@grasp-os/shared/agent";
import { agentDocumentsMax } from "@grasp-os/shared/agents";
import type { AgentDocument } from "@grasp-os/shared/agents";
import { actorOf } from "@grasp-os/shared/audit";
import { requireAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { readAgent } from "./agents.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { readChatFile } from "./chat-files.ts";
import { agentDocuments, agents } from "./db/core/schema.ts";
import type { LocalExtractorEnv } from "./knowledge/extract.ts";
import { requireCompanyAdmin } from "./stephen-reach.ts";

// An agent's documents: files the company's admins give an agent to
// answer from, such as a checklist or a policy too long for its
// instructions. A document is checked and read as a file attached to a
// chat is (chat-files.ts): by what arrived, in the deployment's own
// sandbox, and only its text is kept, here in core's database.
//
// The agent is told its documents by name each turn (agent.ts) and reads
// one through `env.chat.readDocument`, which hands over only a document
// of the agent the chat's turn runs as. So a document reaches exactly the
// people the agent reaches: what an admin puts here, whoever may ask the
// agent may learn. The pages say so where a document is added.
//
// A document is the company's word on the agent's job, written by an
// admin as its instructions are, and like them it adds to Grasp's rules
// and lifts none (agent.ts says so to the model).
//
// The company's own admins add and remove documents, never Grasp staff,
// who read their names only. Each change is audited with the document's
// ID, type and size, never its name or text.
//
// The ways it can fail, which the tests start from: someone who isn't
// the company's own admin adding or removing one; a document read in a
// chat another agent answers; a document added to an agent that was
// deleted meanwhile, or past the most an agent keeps; a deleted agent's
// documents left behind; a change left unaudited.

/** A document's ID, as core makes them. */
const documentIdSchema = z.uuid();

const card = {
  id: agentDocuments.id,
  name: agentDocuments.name,
  type: agentDocuments.type,
  bytes: agentDocuments.bytes,
  addedAt: agentDocuments.addedAt,
};

/** A document's card with how long its text is, in characters. */
const sized = { ...card, chars: sql<number>`length(${agentDocuments.text})` };

const documentOf = (row: {
  id: string;
  name: string;
  type: AgentDocument["type"];
  bytes: number;
  addedAt: Date;
}): AgentDocument => ({
  id: row.id,
  name: row.name,
  type: row.type,
  bytes: row.bytes,
  addedAt: row.addedAt.toISOString(),
});

/** The ID of the agent `agentId`, or `agent.unknown`. */
const requireAgentId = async (env: Env, agentId: unknown): Promise<string> => {
  const agent =
    typeof agentId === "string" ? await readAgent(env, agentId) : undefined;
  if (agent === undefined) {
    throw agentErrors.create("agent.unknown");
  }
  return agent.id;
};

/**
 * The documents core keeps for the agent with this ID, the oldest first,
 * without their text but with its length in characters: what a turn
 * tells the agent it has.
 */
export const documentsOf = async (
  env: Pick<Env, "DB">,
  agentId: string
): Promise<(AgentDocument & { chars: number })[]> => {
  const rows = await drizzle(env.DB)
    .select(sized)
    .from(agentDocuments)
    .where(eq(agentDocuments.agentId, agentId))
    .orderBy(asc(agentDocuments.addedAt), asc(agentDocuments.id));
  return rows.map((row) => ({ ...documentOf(row), chars: row.chars }));
};

/**
 * The documents of the agent `agentId`, the oldest first, without their
 * text: for the company's admins, and Grasp staff, who read only. Throws
 * `agent.unknown`.
 */
export const listAgentDocuments = async (
  env: Env,
  identity: Identity,
  agentId: unknown
): Promise<AgentDocument[]> => {
  requireAdmin(identity);
  const id = await requireAgentId(env, agentId);
  const documents = await documentsOf(env, id);
  return documents.map(({ chars: _chars, ...document }) => document);
};

/**
 * One of the agent's documents with its text, or undefined when the agent
 * with this ID has none by `documentId`: another agent's document is
 * never handed over, whatever ID is asked for.
 */
export const readAgentDocument = async (
  env: Pick<Env, "DB">,
  agentId: string,
  documentId: unknown
): Promise<(AgentDocument & { text: string }) | undefined> => {
  const id = documentIdSchema.safeParse(documentId);
  if (!id.success) {
    return undefined;
  }
  const row = await drizzle(env.DB)
    .select({ ...card, text: agentDocuments.text })
    .from(agentDocuments)
    .where(
      and(eq(agentDocuments.agentId, agentId), eq(agentDocuments.id, id.data))
    )
    .get();
  return row === undefined ? undefined : { ...documentOf(row), text: row.text };
};

/** A chat file's refusals, as they are said of a document. */
const asDocument = {
  "agent.file_unsupported": "agent.document_unsupported",
  "agent.file_too_large": "agent.document_too_large",
  "agent.file_busy": "agent.document_busy",
} as const;

/** `file` read as a chat's file is, refused in a document's words. */
const readAsDocument = async (env: LocalExtractorEnv, file: unknown) => {
  try {
    return await readChatFile(env, file);
  } catch (error) {
    const code = agentErrors.codeOf(error);
    if (
      code === "agent.file_unsupported" ||
      code === "agent.file_too_large" ||
      code === "agent.file_busy"
    ) {
      throw agentErrors.create(asDocument[code]);
    }
    throw error;
  }
};

/**
 * The document `named`, which the agent has under the name of a file
 * being added, when its text is the file's: the same file added again,
 * such as by a caller whose first answer was lost, which is told what it
 * was told then. Throws `agent.document_named` for any other file.
 */
const sameOrNamed = async (
  env: Pick<Env, "DB">,
  agentId: string,
  named: AgentDocument,
  text: string
): Promise<AgentDocument> => {
  const kept = await readAgentDocument(env, agentId, named.id);
  if (kept?.text !== text) {
    throw agentErrors.create("agent.document_named");
  }
  return named;
};

/**
 * Gives the agent `agentId` the file `file` as a document, read as a
 * chat's file is. Throws `agent.unknown`, why a file can't be read in a
 * document's words (`agent.document_unsupported`, `_too_large`, `_busy`),
 * `agent.document_named` when the agent has another file by that name,
 * and `agent.too_many_documents` past {@link agentDocumentsMax}. The same
 * file added again is answered with the document it already is.
 *
 * The insert itself holds what was checked before the file was read: the
 * agent wasn't deleted and has room. Reading a file takes a while, and
 * either may have changed since.
 */
export const addAgentDocument = async (
  env: Env & LocalExtractorEnv,
  identity: Identity,
  agentId: unknown,
  file: unknown
): Promise<AgentDocument> => {
  requireCompanyAdmin(identity);
  const id = await requireAgentId(env, agentId);
  const read = await readAsDocument(env, file);
  const before = await documentsOf(env, id);
  const named = before.find(({ name }) => name === read.name);
  if (named !== undefined) {
    return await sameOrNamed(env, id, named, read.text);
  }
  if (before.length >= agentDocumentsMax) {
    throw agentErrors.create("agent.too_many_documents");
  }
  const document = {
    id: crypto.randomUUID(),
    name: read.name,
    type: read.type,
    bytes: read.bytes,
    addedAt: new Date(),
  };
  const db = drizzle(env.DB);
  const holds = sql`(SELECT count(*) FROM ${agentDocuments} WHERE ${agentDocuments.agentId} = ${id}) < ${agentDocumentsMax}
    AND NOT EXISTS (SELECT 1 FROM ${agents} WHERE ${agents.id} = ${id} AND ${agents.state} = 'deleted')`;
  try {
    await auditedBatch(env, db, [
      db.insert(agentDocuments).select(
        sql`SELECT ${document.id}, ${id}, ${document.name}, ${document.type},
            ${document.bytes}, ${read.text}, ${identity.userId},
            ${document.addedAt.getTime()} WHERE ${holds}`
      ),
      outboxedIfChanged(db, {
        actor: actorOf(identity),
        action: "agent.document.added",
        target: { type: "agent", id },
        detail: {
          documentId: document.id,
          type: document.type,
          bytes: document.bytes,
        },
      }),
    ]);
  } catch (error) {
    // One name added twice at once: the index refuses the second.
    if (!String(error).includes("UNIQUE constraint failed")) {
      throw error;
    }
    const after = await documentsOf(env, id);
    const now = after.find(({ name }) => name === read.name);
    if (now === undefined) {
      throw agentErrors.create("agent.document_named");
    }
    return await sameOrNamed(env, id, now, read.text);
  }
  const kept = await readAgentDocument(env, id, document.id);
  if (kept === undefined) {
    // The insert's condition failed: deleted, or full, since the checks.
    await requireAgentId(env, id);
    throw agentErrors.create("agent.too_many_documents");
  }
  return documentOf({ ...document });
};

/**
 * Takes the document `documentId` from the agent `agentId`, for good.
 * Throws `agent.unknown`, and `agent.document_unknown` when the agent has
 * none by that ID.
 */
export const removeAgentDocument = async (
  env: Env,
  identity: Identity,
  agentId: unknown,
  documentId: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  const id = await requireAgentId(env, agentId);
  const document = await readAgentDocument(env, id, documentId);
  if (document === undefined) {
    throw agentErrors.create("agent.document_unknown");
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .delete(agentDocuments)
      .where(
        and(eq(agentDocuments.agentId, id), eq(agentDocuments.id, document.id))
      ),
    // Recorded only if this removed it: removed twice at once, once.
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.document.removed",
      target: { type: "agent", id },
      detail: {
        documentId: document.id,
        type: document.type,
        bytes: document.bytes,
      },
    }),
  ]);
};
