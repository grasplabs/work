import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { saveUserMemory } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  newAgent,
  purged,
  rememberAs,
  saveOver,
  setUpTime,
} from "./knowledge-purge.ts";
import type { Person } from "./knowledge-purge.ts";
import { storedVersionTexts as versionTexts } from "./knowledge.ts";
import { auditedDuring, refusal, signedInApi, unique } from "./sign-in.ts";

// A content purge and a person's own collections (access `me`: their
// Personal collection with USER.md, and any they made for themselves),
// which only their owner reads, admins included. The ways it can fail: an
// admin tries terms one by one against someone else's private document
// and learns from the counts what it says; an admin tells a private
// document from one that doesn't exist, by the error, its details, or an
// audit event one leaves and the other doesn't; an admin runs a purge on
// one and changes it, or the owner's memory records; and the fix takes
// away what the owner, or a purge of shared knowledge, could do before.

const idp = mockIdp();

const personOf = async (role: Role) => await signedInApi(idp, role);

/** What a document that doesn't exist, or can't be seen, is answered with. */
const notFound =
  "There's no such collection, document or version, or you can't see it.";

/** What a refusal tells its caller, with `id` written as `<id>`. */
const answerOf = (error: unknown, id: string): unknown => {
  if (typeof error !== "object" || error === null) {
    return error;
  }
  const code = "code" in error ? error.code : undefined;
  const details = "details" in error ? error.details : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return JSON.parse(
    JSON.stringify({ code, message, details }).replaceAll(id, "<id>")
  );
};

/** `owner`'s USER.md, holding `text`, and a document in a collection of their own. */
const privateDocumentsOf = async (owner: Person, text: string) => {
  const agent = newAgent();
  const user = await saveUserMemory(
    env,
    actingFor(agent, owner.userId),
    await newChat(agent),
    { type: "own" },
    { text: `# About me\n${text}`, ifVersion: 0 }
  );
  const mine = await owner.api.knowledge.createCollection({
    name: `Mine ${unique()}`,
    access: "me",
  });
  const note = await saveOver(owner, mine.id, "note.md", `# Note\n${text}`);
  return { user, note };
};

/** `owner`'s own memory statements, sorted. */
const statementsOf = async (owner: Person): Promise<string[]> => {
  const { records } = await owner.api.knowledge.memoriesList();
  return records.map(({ statement }) => statement).toSorted();
};

describe(
  "a content purge of someone else's private document",
  setUpTime,
  () => {
    it("answers an admin trying terms one by one exactly as for a document that doesn't exist", async () => {
      const admin = await personOf("admin");
      const owner = await personOf("user");
      const secret = `Diagnosis${unique()}`;
      const { user, note } = await privateDocumentsOf(
        owner,
        `I told the doctor: ${secret}.`
      );
      const handbook = await admin.api.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        access: "everyone",
      });
      const shared = await saveOver(
        admin,
        handbook.id,
        "shared.md",
        `# Shared\n${secret} is not here.`
      );
      // A term the documents hold, one they don't, and one only in part.
      const terms = [secret, `Absent${unique()}`, secret.slice(0, -2)];
      const answers: { named: unknown; missing: unknown }[] = [];
      const events = await auditedDuring(async () => {
        for (const term of terms) {
          for (const documentId of [user.id, note.id]) {
            const missing = crypto.randomUUID();
            for (const ids of [[documentId], [shared.id, documentId]]) {
              const asked = (id: string): PurgeInput => ({
                type: "content",
                documentIds: ids.map((each) =>
                  each === documentId ? id : each
                ),
                terms: [term],
                reason: "erasure_request",
              });
              // oxlint-disable-next-line no-await-in-loop -- one try after another, as an admin would
              const named = await refusal(
                admin.api.knowledge.preparePurge(asked(documentId))
              );
              // oxlint-disable-next-line no-await-in-loop -- one try after another, as an admin would
              const gone = await refusal(
                admin.api.knowledge.preparePurge(asked(missing))
              );
              answers.push({
                named: answerOf(named, documentId),
                missing: answerOf(gone, missing),
              });
            }
          }
        }
      });
      expect({
        different: answers.filter(
          ({ named, missing }) =>
            JSON.stringify(named) !== JSON.stringify(missing)
        ),
        first: answers[0]?.named,
        events: events.map(({ action }) => action),
      }).toStrictEqual({
        different: [],
        first: {
          code: "knowledge.not_found",
          message: notFound,
          details: { documentIds: ["<id>"] },
        },
        events: [],
      });
    });

    it("changes nothing in the owner's documents or memory records when an admin runs it", async () => {
      const admin = await personOf("admin");
      const owner = await personOf("user");
      const secret = `Salary${unique()}`;
      const { user, note } = await privateDocumentsOf(
        owner,
        `My ${secret} is low.`
      );
      await rememberAs(owner, `My ${secret} is low.`);
      const handbook = await admin.api.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        access: "everyone",
      });
      const shared = await saveOver(
        admin,
        handbook.id,
        "shared.md",
        "# Shared\nNothing of it here."
      );
      // The one token an admin can get: for a purge of what they may name.
      const { token } = await admin.api.knowledge.preparePurge({
        type: "content",
        documentIds: [shared.id],
        terms: [secret],
        reason: "erasure_request",
      });
      const before = {
        user: await versionTexts(user.id),
        note: await versionTexts(note.id),
        memories: await statementsOf(owner),
      };
      const runs: unknown[] = [];
      const events = await auditedDuring(async () => {
        for (const documentIds of [
          [user.id],
          [note.id],
          [shared.id, note.id],
        ]) {
          // oxlint-disable-next-line no-await-in-loop -- one try after another
          const run = await refusal(
            admin.api.knowledge.purge(
              {
                type: "content",
                documentIds,
                terms: [secret],
                reason: "erasure_request",
              },
              token
            )
          );
          runs.push(
            typeof run === "object" && run !== null && "code" in run
              ? run.code
              : run
          );
        }
      });
      const read = await owner.api.knowledge.getDocument(note.id);
      expect({
        runs,
        events: events.map(({ action }) => action),
        user: await versionTexts(user.id),
        note: await versionTexts(note.id),
        memories: await statementsOf(owner),
        read: read.version.text,
      }).toStrictEqual({
        runs: [
          "knowledge.purge_expired",
          "knowledge.purge_expired",
          "knowledge.purge_expired",
        ],
        events: [],
        ...before,
        read: `# Note\nMy ${secret} is low.`,
      });
    });

    it("still lets an admin who owns the collection purge it, and purges shared knowledge as before", async () => {
      const owner = await personOf("admin");
      const other = await personOf("admin");
      const name = `Visser${unique()}`;
      const { user, note } = await privateDocumentsOf(
        owner,
        `Call me ${name}.`
      );
      const handbook = await other.api.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        access: "everyone",
      });
      const shared = await saveOver(
        other,
        handbook.id,
        "shared.md",
        `# Shared\nAsk ${name}.`
      );
      const refused = await refusal(
        other.api.knowledge.preparePurge({
          type: "content",
          documentIds: [note.id],
          terms: [name],
          reason: "erasure_request",
        })
      );
      const own = await purged(owner, {
        type: "content",
        documentIds: [user.id, note.id],
        terms: [name],
        reason: "erasure_request",
      });
      const sharedPurge = await purged(other, {
        type: "content",
        documentIds: [shared.id],
        terms: [name],
        reason: "erasure_request",
      });
      expect({
        refused: answerOf(refused, note.id),
        own: {
          documents: own.plan.documents,
          occurrences: own.plan.occurrences,
          result: own.result.documents,
        },
        user: await versionTexts(user.id),
        note: await versionTexts(note.id),
        shared: {
          occurrences: sharedPurge.plan.occurrences,
          texts: await versionTexts(shared.id),
        },
      }).toStrictEqual({
        refused: {
          code: "knowledge.not_found",
          message: notFound,
          details: { documentIds: ["<id>"] },
        },
        own: { documents: 2, occurrences: 2, result: 2 },
        user: [
          "# About me\nCall me (removed).",
          "# About me\nCall me (removed).",
        ],
        note: ["# Note\nCall me (removed).", "# Note\nCall me (removed)."],
        shared: {
          occurrences: 1,
          texts: ["# Shared\nAsk (removed).", "# Shared\nAsk (removed)."],
        },
      });
    });
  }
);
