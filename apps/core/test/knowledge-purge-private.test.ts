import type { PurgeInput, PurgeStatus } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { advanceExports } from "../src/knowledge/brain-export.ts";
import { saveUserMemory } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  apiWith,
  newAgent,
  purged,
  rebuildFailingOnce,
  rememberAs,
  saveOver,
  setUpTime,
} from "./knowledge-purge.ts";
import type { Person } from "./knowledge-purge.ts";
import { newTeam, storedVersionTexts as versionTexts } from "./knowledge.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  refusal,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

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

/**
 * What a refusal tells its caller, with `id` written as `<id>`, or each ID
 * of `id` as its label.
 */
const answerOf = (
  error: unknown,
  id: string | Record<string, string>
): unknown => {
  if (typeof error !== "object" || error === null) {
    return error;
  }
  const code = "code" in error ? error.code : undefined;
  const details = "details" in error ? error.details : undefined;
  const message = error instanceof Error ? error.message : undefined;
  const labels = typeof id === "string" ? { [id]: "<id>" } : id;
  let told = JSON.stringify({ code, message, details });
  for (const [each, label] of Object.entries(labels)) {
    told = told.replaceAll(each, label);
  }
  return JSON.parse(told);
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

/** A statement that rewrites a document's versions. */
const rewritesVersions = /^update "versions"/iu;

/** A statement that redacts or deletes memory records. */
const writesRecords = /^(?:update|delete from) "brain_memories"/iu;

/**
 * `person`'s API on a connection whose Knowledge database refuses the
 * first batch after a statement `pattern` matches: a purge stopped there.
 */
const failingOnce = async (person: Person, pattern: RegExp) => {
  let armed = false;
  let failed = false;
  return await apiWith(person, {
    prepare: (query) => {
      armed ||= !failed && pattern.test(query);
    },
    beforeBatch: () => {
      if (armed) {
        armed = false;
        failed = true;
        throw new Error("D1 is unavailable");
      }
    },
  });
};

/**
 * `person`'s API on a connection that runs `meanwhile` once, before the
 * first batch after a statement `pattern` matches: something someone else
 * does at that point of a purge.
 */
const withOnce = async (
  person: Person,
  pattern: RegExp,
  meanwhile: () => Promise<unknown>
) => {
  let armed = false;
  let done = false;
  return await apiWith(person, {
    prepare: (query) => {
      armed ||= !done && pattern.test(query);
    },
    beforeBatch: async () => {
      if (armed) {
        armed = false;
        done = true;
        await meanwhile();
      }
    },
  });
};

/** A statement that rebuilds the search index. */
const rebuildsIndex = /VALUES \('rebuild'\)/u;

/** A statement that changes a purge's step: one beginning, say. */
const changesAStep = /^update "brain_purge_steps"/iu;

/**
 * What `other` is told finishing `owner`'s one unfinished purge by its ID,
 * and whether that changed its steps, wrote to the audit log, or let an
 * export begin.
 */
const refusedToFinish = async (owner: Person, other: Person) => {
  const open = await env.KNOWLEDGE.prepare(
    "SELECT id FROM brain_purges WHERE by = ? AND completed_at IS NULL"
  )
    .bind(owner.userId)
    .first<{ id: string }>();
  const purgeId = open?.id ?? "";
  const before = await other.api.knowledge.purgeStatus(purgeId);
  let answer = "";
  const events = await auditedDuring(async () => {
    answer = await outcome(other.api.knowledge.finishPurge(purgeId));
  });
  const after = await other.api.knowledge.purgeStatus(purgeId);
  const exportOpen = await outcome(
    other.api.knowledge
      .prepareBrainExport()
      .then(
        async ({ token }) => await other.api.knowledge.startBrainExport(token)
      )
  );
  return {
    answer,
    sameSteps:
      before.state !== "complete" &&
      JSON.stringify(before) === JSON.stringify(after),
    events: events.map(({ action }) => action),
    exportOpen,
  };
};

/**
 * A purge of a shared document by one admin, left unfinished at its last
 * step, the index rebuild, with its document already rewritten; another
 * admin to finish it.
 */
const leftAtTheRebuild = async () => {
  const owner = await personOf("admin");
  const other = await personOf("admin");
  const secret = `Bonus${unique()}`;
  const handbook = await other.api.knowledge.createCollection({
    name: `Handbook ${unique()}`,
    access: "everyone",
  });
  const shared = await saveOver(
    other,
    handbook.id,
    "pay.md",
    `# Pay\nAsk ${secret}.`
  );
  const input: PurgeInput = {
    type: "content",
    documentIds: [shared.id],
    terms: [secret],
    reason: "erasure_request",
  };
  const failing = await rebuildFailingOnce(owner);
  const first = await owner.api.knowledge.preparePurge(input);
  await refusal(failing.knowledge.purge(input, first.token));
  return { owner, other, shared, secret, input };
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

    it("tells another admin nothing of an unfinished purge its owner began there, and lets the owner finish it", async () => {
      const owner = await personOf("admin");
      const other = await personOf("admin");
      const secret = `Pension${unique()}`;
      const { note } = await privateDocumentsOf(owner, `My ${secret} plan.`);
      const input: PurgeInput = {
        type: "content",
        documentIds: [note.id],
        terms: [secret],
        reason: "erasure_request",
      };
      // The owner's own purge, left unfinished: its index rebuild fails.
      const failing = await rebuildFailingOnce(owner);
      const first = await owner.api.knowledge.preparePurge(input);
      const left = await refusal(failing.knowledge.purge(input, first.token));
      const missing = crypto.randomUUID();
      let answers: unknown[] = [];
      const events = await auditedDuring(async () => {
        answers = [
          // The same purge, and another term, against the owner's note.
          answerOf(
            await refusal(other.api.knowledge.preparePurge(input)),
            note.id
          ),
          answerOf(
            await refusal(
              other.api.knowledge.preparePurge({
                ...input,
                terms: [`Other${unique()}`],
              })
            ),
            note.id
          ),
          // As for a document that doesn't exist.
          answerOf(
            await refusal(
              other.api.knowledge.preparePurge({
                ...input,
                documentIds: [missing],
              })
            ),
            missing
          ),
        ];
      });
      const finished = await purged(owner, input);
      const status = await owner.api.knowledge.purgeStatus(
        finished.result.purgeId
      );
      const notFoundAnswer = {
        code: "knowledge.not_found",
        message: notFound,
        details: { documentIds: ["<id>"] },
      };
      expect({
        left:
          typeof left === "object" && left !== null && "code" in left
            ? left.code
            : left,
        answers,
        events: events.map(({ action }) => action),
        status: status.state,
      }).toStrictEqual({
        left: "knowledge.purge_index_pending",
        answers: [notFoundAnswer, notFoundAnswer, notFoundAnswer],
        events: [],
        status: "complete",
      });
    });

    it("names someone else's private document where it stands among documents that don't exist", async () => {
      const admin = await personOf("admin");
      const owner = await personOf("user");
      const { note } = await privateDocumentsOf(owner, "Nothing to see.");
      const handbook = await admin.api.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        access: "everyone",
      });
      const shared = await saveOver(
        admin,
        handbook.id,
        "shared.md",
        "# Shared\nHere."
      );
      const [first, last, instead] = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      const asked = async (second: string) =>
        await refusal(
          admin.api.knowledge.preparePurge({
            type: "content",
            documentIds: [first, second, shared.id, last],
            terms: ["Here"],
            reason: "erasure_request",
          })
        );
      const labels = { [first]: "<1>", [shared.id]: "<3>", [last]: "<4>" };
      expect(
        answerOf(await asked(note.id), { ...labels, [note.id]: "<2>" })
      ).toStrictEqual(
        answerOf(await asked(instead), { ...labels, [instead]: "<2>" })
      );
    });

    it("still lets an admin purge a team's collection they aren't in", async () => {
      const admin = await personOf("admin");
      const keeper = await personOf("admin");
      const member = await personOf("user");
      const teamId = await newTeam(keeper, [member]);
      const name = `Jansen${unique()}`;
      const teamNotes = await keeper.api.knowledge.createCollection({
        name: `Team ${unique()}`,
        access: "teams",
        teams: [teamId],
      });
      const note = await saveOver(
        keeper,
        teamNotes.id,
        "note.md",
        `# Note\nAsk ${name}.`
      );
      const read = await refusal(admin.api.knowledge.getDocument(note.id));
      const { plan } = await purged(admin, {
        type: "content",
        documentIds: [note.id],
        terms: [name],
        reason: "erasure_request",
      });
      expect({
        read: answerOf(read, note.id),
        occurrences: plan.occurrences,
        texts: await versionTexts(note.id),
      }).toStrictEqual({
        read: { code: "knowledge.not_found", message: notFound },
        occurrences: 1,
        texts: ["# Note\nAsk (removed).", "# Note\nAsk (removed)."],
      });
    });

    it("tells another admin nothing of an unfinished purge once its owner's private document is gone", async () => {
      const owner = await personOf("admin");
      const other = await personOf("admin");
      const secret = `Benefit${unique()}`;
      const { personal } = await owner.api.memory.collections();
      const note = await saveOver(
        owner,
        personal,
        "benefits.md",
        `# Benefits\n${secret}.`
      );
      const input: PurgeInput = {
        type: "content",
        documentIds: [note.id],
        terms: [secret],
        reason: "erasure_request",
      };
      const failing = await rebuildFailingOnce(owner);
      const first = await owner.api.knowledge.preparePurge(input);
      await refusal(failing.knowledge.purge(input, first.token));
      // The owner's Personal collection goes, the note with it, while
      // their purge is unfinished.
      await purged(other, {
        type: "personal",
        userId: owner.userId,
        reason: "offboarding",
      });
      const missing = crypto.randomUUID();
      let answers: unknown[] = [];
      const events = await auditedDuring(async () => {
        answers = [
          answerOf(
            await refusal(other.api.knowledge.preparePurge(input)),
            note.id
          ),
          answerOf(
            await refusal(
              other.api.knowledge.preparePurge({
                ...input,
                terms: [`Other${unique()}`],
              })
            ),
            note.id
          ),
          answerOf(
            await refusal(
              other.api.knowledge.preparePurge({
                ...input,
                documentIds: [missing],
              })
            ),
            missing
          ),
        ];
      });
      const notFoundAnswer = {
        code: "knowledge.not_found",
        message: notFound,
        details: { documentIds: ["<id>"] },
      };
      // Left open, it would hold back every export after it: finished by
      // its ID, as nobody can run it again.
      const open = await env.KNOWLEDGE.prepare(
        "SELECT id FROM brain_purges WHERE by = ? AND completed_at IS NULL"
      )
        .bind(owner.userId)
        .first<{ id: string }>();
      const finished = await other.api.knowledge.finishPurge(open?.id ?? "");
      expect({
        answers,
        events: events.map(({ action }) => action),
        finished: finished.state,
      }).toStrictEqual({
        answers: [notFoundAnswer, notFoundAnswer, notFoundAnswer],
        events: [],
        finished: "complete",
      });
    });

    it("is finished by another admin by its ID alone once its owner left, so exports work again", async () => {
      const owner = await personOf("admin");
      const other = await personOf("admin");
      const member = await personOf("user");
      const staffRpc = await openRpc(
        await signedIn(idp, "grasp-staff", staffPerson())
      );
      const staff = staffRpc.core.authenticate();
      const secret = `Leave${unique()}`;
      const handbook = await other.api.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        access: "everyone",
      });
      const shared = await saveOver(
        other,
        handbook.id,
        "leave.md",
        `# Leave\nAsk ${secret}.`
      );
      const { personal } = await owner.api.memory.collections();
      const own = await saveOver(
        owner,
        personal,
        "leave.md",
        `# Mine\n${secret}.`
      );
      const input: PurgeInput = {
        type: "content",
        documentIds: [own.id, shared.id],
        terms: [secret],
        reason: "erasure_request",
      };
      // The owner's purge is left unfinished: its index rebuild fails.
      const failing = await rebuildFailingOnce(owner);
      const first = await owner.api.knowledge.preparePurge(input);
      await refusal(failing.knowledge.purge(input, first.token));
      // Its ID, as the audit log and its status name it.
      const open = await env.KNOWLEDGE.prepare(
        "SELECT id FROM brain_purges WHERE by = ? AND completed_at IS NULL"
      )
        .bind(owner.userId)
        .first<{ id: string }>();
      const purgeId = open?.id ?? "";
      // They leave: their Personal collection goes, and they are an admin
      // no more.
      await purged(other, {
        type: "personal",
        userId: owner.userId,
        reason: "offboarding",
      });
      await other.api.members.setRole(owner.userId, "user");
      const stuck = {
        prepare: await outcome(other.api.knowledge.preparePurge(input)),
        exportOpen: await outcome(
          other.api.knowledge
            .prepareBrainExport()
            .then(
              async ({ token }) =>
                await other.api.knowledge.startBrainExport(token)
            )
        ),
      };
      const refused = {
        member: await outcome(member.api.knowledge.finishPurge(purgeId)),
        staff: await outcome(staff.knowledge.finishPurge(purgeId)),
      };
      const statuses: PurgeStatus[] = [];
      const events = await auditedDuring(async () => {
        statuses.push(await other.api.knowledge.finishPurge(purgeId));
      });
      const [finished] = statuses;
      const again = answerOf(
        await refusal(other.api.knowledge.finishPurge(purgeId)),
        purgeId
      );
      const unknownId = crypto.randomUUID();
      const unknown = answerOf(
        await refusal(other.api.knowledge.finishPurge(unknownId)),
        unknownId
      );
      const plan = await other.api.knowledge.prepareBrainExport();
      const { exportId } = await other.api.knowledge.startBrainExport(
        plan.token
      );
      let exported = "running";
      for (let tick = 0; tick < 20 && exported === "running"; tick += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one clock tick after another
        await advanceExports(env, new Date());
        // oxlint-disable-next-line no-await-in-loop -- read after each tick
        const now = await other.api.knowledge.brainExportStatus(exportId);
        exported = now.state;
      }
      const sharedTexts = await versionTexts(shared.id);
      expect({
        stuck,
        refused,
        state: finished?.state,
        // Nothing of what it removed, nor where: no counts, no document.
        steps: finished?.steps.map(({ step, counts }) => [step, counts]),
        finishedBy: events
          .filter(({ action }) => action === "knowledge.purge.resumed")
          .map(({ actor, detail }) => [actor, detail]),
        again,
        unknown,
        shared: sharedTexts.some((text) => text.includes(secret)),
        exported,
      }).toStrictEqual({
        stuck: {
          prepare: "knowledge.not_found",
          exportOpen: "knowledge.export_purge_open",
        },
        refused: {
          member: "role.forbidden",
          staff: "role.forbidden",
        },
        state: "complete",
        steps: [
          ["statements", {}],
          ["host_copies", {}],
          ["host_documents", {}],
          ["document", {}],
          ["document", {}],
          ["payloads", {}],
          ["search", {}],
        ],
        finishedBy: [
          [
            { type: "person", userId: other.userId },
            { purgeId, kind: "content", byId: true },
          ],
        ],
        again: { code: "knowledge.not_found", message: notFound },
        unknown: { code: "knowledge.not_found", message: notFound },
        shared: false,
        exported: "complete",
      });
    });

    it("is not finished by its ID while a document it names still holds its text", async () => {
      const owner = await personOf("admin");
      const other = await personOf("admin");
      const secret = `Salary${unique()}`;
      const handbook = await other.api.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        access: "everyone",
      });
      const shared = await saveOver(
        other,
        handbook.id,
        "pay.md",
        `# Pay\nAsk ${secret}.`
      );
      const input: PurgeInput = {
        type: "content",
        documentIds: [shared.id],
        terms: [secret],
        reason: "erasure_request",
      };
      // The owner's purge stops at the document: rewriting its versions fails.
      const failing = await failingOnce(owner, rewritesVersions);
      const first = await owner.api.knowledge.preparePurge(input);
      await refusal(failing.knowledge.purge(input, first.token));
      const told = await refusedToFinish(owner, other);
      // Run again by the owner, it finishes, as before.
      await purged(owner, input);
      const [text] = await versionTexts(shared.id);
      expect({ ...told, text }).toStrictEqual({
        answer: "knowledge.purge_needs_input",
        sameSteps: true,
        events: [],
        exportOpen: "knowledge.export_purge_open",
        text: "# Pay\nAsk (removed).",
      });
    });

    it("is not finished by its ID while it owes what needs its terms", async () => {
      const owner = await personOf("admin");
      const other = await personOf("admin");
      const secret = `Diagnosis${unique()}`;
      const { personal } = await owner.api.memory.collections();
      const note = await saveOver(
        owner,
        personal,
        "health.md",
        `# Health\n${secret}.`
      );
      await rememberAs(other, `Covering for ${secret}.`);
      const input: PurgeInput = {
        type: "content",
        documentIds: [note.id],
        terms: [secret],
        reason: "erasure_request",
      };
      // The owner's purge stops at the memory records, its first step.
      const failing = await failingOnce(owner, writesRecords);
      const first = await owner.api.knowledge.preparePurge(input);
      await refusal(failing.knowledge.purge(input, first.token));
      // The note goes: no document of it is left, only what needs the terms.
      await purged(other, {
        type: "personal",
        userId: owner.userId,
        reason: "offboarding",
      });
      const told = await refusedToFinish(owner, other);
      // Its starter runs it again, the note gone, and it finishes.
      await purged(owner, input);
      const { records } = await other.api.knowledge.memoriesList();
      expect({
        ...told,
        memory: records.some(({ statement }) => statement.includes(secret)),
      }).toStrictEqual({
        answer: "knowledge.purge_needs_input",
        sameSteps: true,
        events: [],
        exportOpen: "knowledge.export_purge_open",
        memory: false,
      });
    });

    it("answers a personal purge left unfinished as it answers an ID nobody has", async () => {
      const admin = await personOf("admin");
      const leaver = await personOf("user");
      const { personal } = await leaver.api.memory.collections();
      await saveOver(leaver, personal, "notes.md", "# Notes\nMine.");
      const input: PurgeInput = {
        type: "personal",
        userId: leaver.userId,
        reason: "offboarding",
      };
      const failing = await rebuildFailingOnce(admin);
      const first = await admin.api.knowledge.preparePurge(input);
      await refusal(failing.knowledge.purge(input, first.token));
      const open = await env.KNOWLEDGE.prepare(
        "SELECT id FROM brain_purges WHERE kind = 'personal' AND completed_at IS NULL AND by = ?"
      )
        .bind(admin.userId)
        .first<{ id: string }>();
      const purgeId = open?.id ?? "";
      const unknownId = crypto.randomUUID();
      const answers = {
        personal: answerOf(
          await refusal(admin.api.knowledge.finishPurge(purgeId)),
          purgeId
        ),
        unknown: answerOf(
          await refusal(admin.api.knowledge.finishPurge(unknownId)),
          unknownId
        ),
      };
      // Run again, as a personal purge goes on.
      await purged(admin, input);
      expect({ open: purgeId !== "", ...answers }).toStrictEqual({
        open: true,
        personal: answers.unknown,
        unknown: { code: "knowledge.not_found", message: notFound },
      });
    });

    it("is not finished by its ID once a document it purged was saved again since", async () => {
      const { owner, other, shared, secret, input } = await leftAtTheRebuild();
      // Someone saves the term back into the document meanwhile.
      await saveOver(
        other,
        shared.collectionId,
        shared.path,
        `# Pay\nAsk ${secret} again.`
      );
      const told = await refusedToFinish(owner, other);
      // Its starter runs it again: the term goes from the new version too.
      const again = await purged(owner, input);
      const texts = await versionTexts(shared.id);
      const latest = texts.at(-1);
      expect({ ...told, again: again.result.stillFound, latest }).toStrictEqual(
        {
          answer: "knowledge.purge_needs_input",
          sameSteps: true,
          events: [],
          exportOpen: "knowledge.export_purge_open",
          again: 0,
          latest: "# Pay\nAsk (removed) again.",
        }
      );
    });

    it("is not finished by its ID when its record can't prove how it left a document", async () => {
      const { owner, other, input } = await leftAtTheRebuild();
      // A step completed before the version was kept with it.
      await env.KNOWLEDGE.prepare(
        "UPDATE brain_purge_steps SET version = NULL WHERE step LIKE 'document:%' AND purge_id IN (SELECT id FROM brain_purges WHERE by = ? AND completed_at IS NULL)"
      )
        .bind(owner.userId)
        .run();
      const told = await refusedToFinish(owner, other);
      await purged(owner, input);
      expect(told).toStrictEqual({
        answer: "knowledge.purge_needs_input",
        sameSteps: true,
        events: [],
        exportOpen: "knowledge.export_purge_open",
      });
    });

    it("is finished by its ID when every document it purged is as it left it", async () => {
      const { owner, other, shared, secret } = await leftAtTheRebuild();
      const open = await env.KNOWLEDGE.prepare(
        "SELECT id FROM brain_purges WHERE by = ? AND completed_at IS NULL"
      )
        .bind(owner.userId)
        .first<{ id: string }>();
      const finished = await other.api.knowledge.finishPurge(open?.id ?? "");
      const texts = await versionTexts(shared.id);
      expect({
        state: finished.state,
        holds: texts.some((text) => text.includes(secret)),
      }).toStrictEqual({ state: "complete", holds: false });
    });

    it("is not finished by its ID when a document it purged is saved while it finishes", async () => {
      const { owner, other, shared, secret, input } = await leftAtTheRebuild();
      const open = await env.KNOWLEDGE.prepare(
        "SELECT id FROM brain_purges WHERE by = ? AND completed_at IS NULL"
      )
        .bind(owner.userId)
        .first<{ id: string }>();
      const purgeId = open?.id ?? "";
      // The term is saved back as the finish rebuilds the index: after it
      // checked the document, before it completes.
      const finishing = await withOnce(
        other,
        rebuildsIndex,
        async () =>
          await saveOver(
            owner,
            shared.collectionId,
            shared.path,
            `# Pay\nAsk ${secret} once more.`
          )
      );
      const answer = await outcome(finishing.knowledge.finishPurge(purgeId));
      const status = await other.api.knowledge.purgeStatus(purgeId);
      // Its starter runs it again at once: nothing holds it.
      const again = await outcome(purged(owner, input));
      const texts = await versionTexts(shared.id);
      expect({
        answer,
        state: status.state,
        again,
        holds: texts.some((text) => text.includes(secret)),
      }).toStrictEqual({
        answer: "knowledge.purge_needs_input",
        state: "running",
        again: "ok",
        holds: false,
      });
    });

    it("purges a document its own run named that was saved again before its turn", async () => {
      const admin = await personOf("admin");
      const writer = await personOf("admin");
      const secret = `Pension${unique()}`;
      const handbook = await writer.api.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        access: "everyone",
      });
      const page = await saveOver(
        writer,
        handbook.id,
        "plan.md",
        "# Plan\nNothing yet."
      );
      const input: PurgeInput = {
        type: "content",
        documentIds: [page.id],
        terms: [secret],
        reason: "erasure_request",
      };
      const { token } = await admin.api.knowledge.preparePurge(input);
      // Saved with the term once the purge named the document, before
      // the purge's step reaches it.
      const running = await withOnce(
        admin,
        changesAStep,
        async () =>
          await saveOver(
            writer,
            handbook.id,
            "plan.md",
            `# Plan\nAsk ${secret}.`
          )
      );
      const result = await running.knowledge.purge(input, token);
      const texts = await versionTexts(page.id);
      expect({
        stillFound: result.stillFound,
        holds: texts.some((text) => text.includes(secret)),
      }).toStrictEqual({ stillFound: 0, holds: false });
    });
  }
);
