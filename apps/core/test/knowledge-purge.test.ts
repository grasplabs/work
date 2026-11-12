import {
  purgeMaxDocuments,
  purgeMaxTerms,
  purgeTermMaxLength,
} from "@grasp-os/shared/knowledge";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  apiWith,
  holding,
  lettersOf,
  purged,
  rebuildFailingOnce,
  rememberAs,
  saveOver,
  setUpTime,
} from "./knowledge-purge.ts";
import type { Person } from "./knowledge-purge.ts";
import { storedVersionTexts as versionTexts } from "./knowledge.ts";
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

// Purging personal data from Knowledge. These tests start from the ways a
// purge can fail or be abused: the text survives somewhere (an earlier
// version, a section, a title, the search index's pages, a Brain memory, memory cached
// by version); the purge record in the audit log,
// which can't be purged, carries the text it removed; a purge reaches
// documents it wasn't aimed at; someone other than the client's admins
// purges, or purges without confirming, or confirms a purge other than the
// one prepared; and a purge leaves a document that can't be read.

const idp = mockIdp();

const personOf = async (role: Role) => await signedInApi(idp, role);

/** The memory record a remember's receipt names. */
const memoryIdOf = ({
  resourceRefs,
}: Awaited<ReturnType<typeof rememberAs>>): string => {
  const [ref] = resourceRefs;
  return ref?.kind === "memory" ? ref.memoryId : "";
};

/** `person`'s own memory statements, sorted. */
const statementsOf = async (person: Person): Promise<string[]> => {
  const { records } = await person.api.knowledge.memoriesList();
  return records.map(({ statement }) => statement).toSorted();
};

/** Whether a statement of the purge's batch writes or deletes records. */
const writesRecords = (query: string): boolean =>
  /^(?:update|delete from) "brain_memories"/iu.test(query);

describe("a purge of content's memory records", setUpTime, () => {
  it("redacts or deletes every record holding a term, whoever's, audited without the text", async () => {
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const colleague = await personOf("user");
    const name = `Visser${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${name} runs payroll.`
    );
    const key = `purge-${unique()}-${unique()}`;
    const redacted = await leaver.api.knowledge.remember(
      { kind: "fact", text: `I report to ${name}.` },
      { idempotencyKey: key }
    );
    const deleted = await rememberAs(colleague, `${name.toUpperCase()}!`);
    await rememberAs(colleague, "I work in payroll.");
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "erasure_request",
    };
    let outcomeOf: Awaited<ReturnType<typeof purged>> | undefined;
    const events = await auditedDuring(async () => {
      outcomeOf = await purged(admin, input);
    });
    // A retry of the remember answers its receipt: it never stores the
    // statement again.
    const retried = await leaver.api.knowledge.remember(
      { kind: "fact", text: `I report to ${name}.` },
      { idempotencyKey: key }
    );
    const leavers = await leaver.api.knowledge.memoriesList();
    const colleagues = await colleague.api.knowledge.memoriesList();
    const purgeId = outcomeOf?.result.purgeId;
    expect({
      stillFound: outcomeOf?.result.stillFound,
      leavers: leavers.records.map(({ statement, revision }) => ({
        statement,
        revision,
      })),
      colleagues: colleagues.records.map(({ statement }) => statement),
      deleted: await outcome(
        colleague.api.knowledge.memoriesGet({ memoryId: memoryIdOf(deleted) })
      ),
      receipts: [
        await outcome(
          leaver.api.knowledge.receiptsGet({ receiptId: redacted.id })
        ),
        await outcome(
          colleague.api.knowledge.receiptsGet({ receiptId: deleted.id })
        ),
      ],
      retried: retried.id === redacted.id,
      held: await holding(name),
      memoryEvents: events
        .filter(({ action }) => action === "knowledge.memory.purged")
        .map(({ actor, target, detail }) => ({ actor, target, detail }))
        .toSorted((one, other) =>
          (one.target?.id ?? "").localeCompare(other.target?.id ?? "")
        ),
      carriesText: JSON.stringify(events)
        .toLowerCase()
        .includes(name.toLowerCase()),
    }).toStrictEqual({
      stillFound: 0,
      leavers: [{ statement: "I report to (removed).", revision: 2 }],
      colleagues: ["I work in payroll."],
      deleted: "brain.not_found",
      receipts: ["ok", "ok"],
      retried: true,
      held: [],
      memoryEvents: [
        {
          actor: { type: "person", userId: admin.userId },
          target: { type: "memory", id: memoryIdOf(redacted) },
          detail: { purgeId, change: "redacted", revision: 1 },
        },
        {
          actor: { type: "person", userId: admin.userId },
          target: { type: "memory", id: memoryIdOf(deleted) },
          detail: { purgeId, change: "deleted", revision: 1 },
        },
      ].toSorted((one, other) => one.target.id.localeCompare(other.target.id)),
      carriesText: false,
    });
  });

  it("changes neither records nor documents when its batch of records fails, and finishes when run again", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const name = `Bakker${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${name} runs payroll.`
    );
    await rememberAs(teammate, `${name} approves leave.`);
    await rememberAs(teammate, `Ask ${name} first.`);
    let failNext = false;
    const failing = await apiWith(admin, {
      prepare: (query) => {
        failNext ||= writesRecords(query);
      },
      beforeBatch: () => {
        if (failNext) {
          failNext = false;
          throw new Error("D1 is unavailable");
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "erasure_request",
    };
    const plan = await failing.knowledge.preparePurge(input);
    const refused = await outcome(failing.knowledge.purge(input, plan.token));
    const afterFailure = {
      memories: await statementsOf(teammate),
      document: await versionTexts(document.id),
    };
    const again = await purged(admin, input);
    expect({
      refused: refused === "ok",
      afterFailure,
      again: again.result.stillFound,
      memories: await statementsOf(teammate),
      held: await holding(name),
    }).toStrictEqual({
      refused: false,
      afterFailure: {
        memories: [`${name} approves leave.`, `Ask ${name} first.`].toSorted(),
        document: [`# Team\n${name} runs payroll.`],
      },
      again: 0,
      memories: [
        "(removed) approves leave.",
        "Ask (removed) first.",
      ].toSorted(),
      held: [],
    });
  });

  it("leaves a record remembered after it read them to a run again, which erases it", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const name = `Smit${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${name} runs payroll.`
    );
    await rememberAs(teammate, `${name} approves leave.`);
    // Another remember lands between the purge's read of the records and
    // its batch rewriting them.
    let raceNext = false;
    let raced = false;
    const racing = await apiWith(admin, {
      prepare: (query) => {
        raceNext ||= !raced && writesRecords(query);
      },
      beforeBatch: async () => {
        if (raceNext) {
          raceNext = false;
          raced = true;
          await rememberAs(teammate, `Thank ${name}.`);
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "erasure_request",
    };
    const plan = await racing.knowledge.preparePurge(input);
    await racing.knowledge.purge(input, plan.token);
    const afterRace = await statementsOf(teammate);
    const again = await purged(admin, input);
    expect({
      raced,
      afterRace,
      again: again.result.stillFound,
      memories: await statementsOf(teammate),
      held: await holding(name),
    }).toStrictEqual({
      raced: true,
      afterRace: ["(removed) approves leave.", `Thank ${name}.`].toSorted(),
      again: 0,
      memories: ["(removed) approves leave.", "Thank (removed)."].toSorted(),
      held: [],
    });
  });

  it("finds a term typed with a combining accent or in another case as the same word", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const suffix = unique();
    const term = `Ren\u00E9${suffix}`;
    const decomposed = `Rene\u0301${suffix}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${term} runs payroll.`
    );
    await rememberAs(teammate, `I report to ${term}.`);
    await rememberAs(teammate, `Ask ${term.toUpperCase()} first.`);
    await rememberAs(teammate, `I met ${decomposed} today.`);
    // Typed decomposed as a term too: the same word.
    const { result } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [decomposed],
      reason: "erasure_request",
    });
    expect({
      stillFound: result.stillFound,
      memories: await statementsOf(teammate),
    }).toStrictEqual({
      stillFound: 0,
      memories: [
        "Ask (removed) first.",
        "I met (removed) today.",
        "I report to (removed).",
      ].toSorted(),
    });
  });

  it("leaves in memory records the forms it leaves on purpose, though the index would find them", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const suffix = unique();
    const term = `Ren\u00E9${suffix}`;
    const pair = `fiona${suffix} visser`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${term} and ${pair} run payroll.`
    );
    // Without its accent, joined by a hyphen, and with a ligature: not
    // the term as typed, so left, but the same tokens to the index.
    const left = [
      `Ask Rene${suffix} first.`,
      `Ask fiona${suffix}-visser first.`,
      `Ask \uFB01ona${suffix} visser first.`,
    ];
    for (const text of left) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await rememberAs(teammate, text);
    }
    await rememberAs(teammate, `Ask ${term} first.`);
    // Inside a longer word: another token.
    await rememberAs(teammate, `Ask Renes${suffix}x first.`);
    const { result } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [term, pair],
      reason: "erasure_request",
    });
    expect({
      stillFound: result.stillFound,
      memories: await statementsOf(teammate),
    }).toStrictEqual({
      stillFound: 0,
      memories: [
        ...left,
        "Ask (removed) first.",
        `Ask Renes${suffix}x first.`,
      ].toSorted(),
    });
  });

  it("leaves a record changed between its read and its batch, unrecorded", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const other = await personOf("user");
    const name = `Jansen${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${name} runs payroll.`
    );
    await rememberAs(teammate, `${name} approves leave.`);
    await rememberAs(other, `Ask ${name}.`);
    // The teammate's record gets a new revision once the purge has read
    // it: a concurrent change, which the purge must not overwrite.
    let changeNext = false;
    let changed = false;
    const racing = await apiWith(admin, {
      prepare: (query) => {
        changeNext ||= !changed && writesRecords(query);
      },
      beforeBatch: async () => {
        if (changeNext) {
          changeNext = false;
          changed = true;
          await env.KNOWLEDGE.prepare(
            "UPDATE brain_memories SET statement = statement || ' Again.', revision = revision + 1 WHERE owner_id = ?"
          )
            .bind(teammate.userId)
            .run();
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "erasure_request",
    };
    const events = await auditedDuring(async () => {
      const plan = await racing.knowledge.preparePurge(input);
      await racing.knowledge.purge(input, plan.token);
    });
    expect({
      changed,
      teammate: await statementsOf(teammate),
      other: await statementsOf(other),
      events: events.filter(
        ({ action }) => action === "knowledge.memory.purged"
      ).length,
    }).toStrictEqual({
      changed: true,
      teammate: [`${name} approves leave. Again.`],
      other: ["Ask (removed)."],
      events: 1,
    });
  });

  it("removes a term where the index's tokens differ: a script without spaces, an emoji, a final sigma", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const tag = unique();
    const cjk = `\u7530\u4E2D${tag}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nNothing."
    );
    await rememberAs(teammate, `${cjk}\u3055\u3093\u306B\u805E\u304F`);
    await rememberAs(teammate, `Ask Tom${tag}\u{1F642} now`);
    await rememberAs(
      teammate,
      `Ask X${tag}\u039F\u0394\u03A5\u03A3\u03A3\u0395\u03A5\u03A3 now`
    );
    const { result } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [
        cjk,
        `Tom${tag}`,
        `x${tag}\u03BF\u03B4\u03C5\u03C3\u03C3\u03B5\u03C5\u03C2`,
      ],
      reason: "erasure_request",
    });
    expect({
      stillFound: result.stillFound,
      memories: await statementsOf(teammate),
    }).toStrictEqual({
      stillFound: 0,
      memories: [
        "(removed)\u3055\u3093\u306B\u805E\u304F",
        "Ask (removed)\u{1F642} now",
        "Ask (removed) now",
      ].toSorted(),
    });
  });

  it("leaves to a run again a record in a script without spaces remembered after it read them", async () => {
    const admin = await personOf("admin");
    const teammate = await personOf("user");
    const cjk = `\u7530\u4E2D${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nNothing."
    );
    await rememberAs(teammate, `${cjk}\u3055\u3093\u306B\u805E\u304F`);
    let raceNext = false;
    let raced = false;
    const racing = await apiWith(admin, {
      prepare: (query) => {
        raceNext ||= !raced && writesRecords(query);
      },
      beforeBatch: async () => {
        if (raceNext) {
          raceNext = false;
          raced = true;
          await rememberAs(teammate, `${cjk}\u3055\u3093\u306B\u611F\u8B1D`);
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [cjk],
      reason: "erasure_request",
    };
    const plan = await racing.knowledge.preparePurge(input);
    await racing.knowledge.purge(input, plan.token);
    expect({
      raced,
      memories: await statementsOf(teammate),
    }).toStrictEqual({
      raced: true,
      memories: [
        "(removed)\u3055\u3093\u306B\u805E\u304F",
        `${cjk}\u3055\u3093\u306B\u611F\u8B1D`,
      ].toSorted(),
    });
  });
});

describe("a purge whose index cleanup fails", setUpTime, () => {
  it("says the data is gone and a run again cleans up, for content", async () => {
    const admin = await personOf("admin");
    const secret = `claes${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `# People\nWrite to ${secret}.`
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [secret],
      reason: "other",
    };
    const failing = await rebuildFailingOnce(admin);
    const { token } = await admin.api.knowledge.preparePurge(input);
    const first = await outcome(failing.knowledge.purge(input, token));
    const heldAfterFirst = await holding(secret);
    // Nothing left to change, but the index is cleaned up.
    const again = await purged(admin, input);
    const status = await admin.api.knowledge.purgeStatus(again.result.purgeId);
    expect({
      first,
      heldAfterFirst,
      // The same purge, gone on with (GRA-1122): what it removed in all.
      again: again.result.versions,
      status: status.state,
      heldAfterAgain: await holding(secret),
    }).toStrictEqual({
      first: "knowledge.purge_index_pending",
      heldAfterFirst: ["search_words_data.block"],
      again: 1,
      status: "complete",
      heldAfterAgain: [],
    });
  });
});

describe("purging", setUpTime, () => {
  it("finds a term the index keeps after a word with the same first letters, whose bytes its pages split", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // "renee…" right after "renee" in the index: kept as the five letters
    // they share, then the rest.
    const term = `renee${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;
    await saveOver(
      admin,
      handbook.id,
      "names.md",
      `# Names\nRene, Renee and ${term}.`
    );
    await expect(holding(term)).resolves.toContain("search_words_data.block");
  });

  it("is only for the client's admins, and never without the token prepared for it", async () => {
    const admin = await personOf("admin");
    const otherAdmin = await personOf("admin");
    const builder = await personOf("builder");
    const user = await personOf("user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const input: PurgeInput = {
      type: "personal",
      userId: user.userId,
      reason: "offboarding",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    const otherInput: PurgeInput = { ...input, reason: "other" };
    const dot = token.indexOf(".");
    const tampered = `${Number(token.slice(0, dot)) + 1}${token.slice(dot)}`;
    const refusals = await Promise.all([
      outcome(builder.api.knowledge.preparePurge(input)),
      outcome(user.api.knowledge.purge(input, token)),
      outcome(staff.knowledge.preparePurge(input)),
      outcome(staff.knowledge.purge(input, token)),
      outcome(otherAdmin.api.knowledge.purge(input, token)),
      outcome(admin.api.knowledge.purge(otherInput, token)),
      outcome(admin.api.knowledge.purge(input, tampered)),
      outcome(admin.api.knowledge.purge(input, "not-a-token")),
      outcome(
        admin.api.knowledge.preparePurge(
          // SAFETY: invalid on purpose: free text as the reason, which a
          // client can send, as Cap'n Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          { ...input, reason: "Jan de Vries left" } as never
        )
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [crypto.randomUUID()],
          terms: ["x"],
          reason: "other",
        })
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: Array.from({ length: purgeMaxDocuments + 1 }, () =>
            crypto.randomUUID()
          ),
          terms: ["Jan"],
          reason: "other",
        })
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [crypto.randomUUID()],
          terms: Array.from(
            { length: purgeMaxTerms + 1 },
            (_, index) => `Jan${index}`
          ),
          reason: "other",
        })
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [crypto.randomUUID()],
          terms: ["x".repeat(purgeTermMaxLength + 1)],
          reason: "other",
        })
      ),
      // Terms the marker holds: a purge would find them again in it.
      // Or that the marker and the text next to it would make again.
      ...[
        "removed",
        "MOVE",
        "(r",
        "d)",
        ") Jan",
        "Jan (",
        "ED) Jan",
        "Jan (rem",
      ].map(
        async (term) =>
          await outcome(
            admin.api.knowledge.preparePurge({
              type: "content",
              documentIds: [crypto.randomUUID()],
              terms: ["Jan", term],
              reason: "other",
            })
          )
      ),
    ]);
    // Past its ten minutes.
    vi.useFakeTimers({ toFake: ["Date"] });
    let expired: string;
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      expired = await outcome(admin.api.knowledge.purge(input, token));
    } finally {
      vi.useRealTimers();
    }
    expect({ refusals, expired }).toStrictEqual({
      refusals: [
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "knowledge.purge_expired",
        "knowledge.purge_expired",
        "knowledge.purge_expired",
        "knowledge.purge_expired",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
      ],
      expired: "knowledge.purge_expired",
    });
    // None of those changed anything: the token still runs it.
    await expect(
      admin.api.knowledge.purge(input, token)
    ).resolves.toMatchObject({ documents: 0, versions: 0 });
  });

  it("refuses a purge that would leave a document that can't be read, and changes nothing", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const other = `holt${unique()}`;
    const kept = await saveOver(
      admin,
      handbook.id,
      "kept.md",
      `# Kept\n${other} stays until the purge is refused.`
    );
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `---\ndescription: HR\n---\n# People\n${other} is here.`
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [kept.id, document.id],
      // Removing it breaks the frontmatter.
      terms: [other, "description:"],
      reason: "other",
    };
    expect({
      prepared: await outcome(admin.api.knowledge.preparePurge(input)),
      kept: await versionTexts(kept.id),
      document: await versionTexts(document.id),
    }).toStrictEqual({
      prepared: "knowledge.invalid",
      kept: [`# Kept\n${other} stays until the purge is refused.`],
      document: [`---\ndescription: HR\n---\n# People\n${other} is here.`],
    });
  });

  it("refuses documents that don't exist, naming them", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const kept = await saveOver(
      admin,
      handbook.id,
      "kept.md",
      "# Kept\nRoos stays."
    );
    const missing = crypto.randomUUID();
    const prepared = await refusal(
      admin.api.knowledge.preparePurge({
        type: "content",
        documentIds: [kept.id, missing],
        terms: ["Roos"],
        reason: "other",
      })
    );
    expect({
      prepared,
      kept: await versionTexts(kept.id),
    }).toMatchObject({
      prepared: {
        code: "knowledge.not_found",
        details: { documentIds: [missing] },
      },
      kept: ["# Kept\nRoos stays."],
    });
  });
});
