import type {
  InterviewFact,
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { Roster } from "@grasp-os/shared/onboarding";
import type { SessionApi } from "@grasp-os/shared/rpc";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { recallAs, workBrain } from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { setObjectEnv } from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { removalsFailingOnce } from "./brain-erasures-failing.ts";
import { mockIdp } from "./idp.ts";
import {
  answering,
  answeringWith as answeringWithRequests,
  approveAgreed,
  holdAlarm,
  onLink,
  openLinkAs,
  signedInAs,
} from "./interview-link.ts";
import { d1ColumnsWith, onboardingTablesWith } from "./kept-where.ts";
import type { Answer, ProviderReply } from "./model-provider.ts";
import { alikeReply, intakeAlike } from "./onboarding-team.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { wordFile } from "./word-file.ts";

// A document shared in the onboarding, whose reading goes when an admin
// removes it or its file is deleted from the Brain (GRA-970, GRA-1889,
// the store's `forgetDocuments`). The onboarding keeps only the reading,
// never the file. Each document here holds a word nobody else says (a
// sentinel), which its reading, the admin's answer and a drawing take up,
// and the tests look for it everywhere it could be left: the store's
// tables, both D1 databases, the audit log, and what an interview turn
// knows. The model provider is the outside system, faked behind connect.
// The ways it can fail, tried here:
//
// - The reading living on after it is removed, in Stephen's context, the
//   admin's list or the brain's sources and tools.
// - A drawing made with the reading for context left in the store or in
//   the brain, or not drawn again.
// - The removal in the audit log with any of the document's words.
// - A drawing under way as the document goes, kept as it ends.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A word nobody else says, as one lower-case token: what must go. */
// Letters only: a drawn part with a digit never reaches the brain (GRA-1084).
const sentinelOf = () =>
  `zorblax${unique().replaceAll(/\d/gu, (digit) => "abcdefghij".charAt(Number(digit)))}`;

/** A Word file that names `word`. */
const documentWith = (word: string) =>
  wordFile([
    "Claims procedure, March 2026",
    `Claims are typed into ${word} by the Ops team.`,
    "A claim above 5,000 euros goes to a manager for approval.",
  ]);

/** The model's reading of `documentWith(word)`: it says the word throughout. */
const readingWith = (word: string): ProviderReply => ({
  text: JSON.stringify({
    about: `How claims are typed into ${word}.`,
    tools: [word, "Zendesk"],
    teams: ["Ops"],
    unclear: [`Who checks what ${word} holds?`],
    question: `Is the ${word} procedure still current?`,
    options: ["Yes", "No"],
  }),
  inputTokens: 1200,
  outputTokens: 150,
});

/** Shares a document named `name` holding `word`, as `admin`, and answers its question: its ID. */
const share = async (
  admin: SessionApi,
  name: string,
  word: string
): Promise<string> => {
  const { result: shared } = await answering(
    [readingWith(word)],
    async () =>
      await admin.onboarding.shareDocument({
        locale: "en",
        name,
        bytes: documentWith(word),
      })
  );
  await admin.onboarding.answerDocument(shared.id, `Only in ${word} now.`);
  return shared.id;
};

/** The people of a team, by key. */
type Key = "lea" | "max" | "mia" | "mo" | "noor" | "pim" | "rik" | "sam";

/**
 * A team called Ops, led by Lea, with Max, Mia, Mo, Noor and Pim, in an
 * onboarding that started yesterday: five who tell their own work, as many
 * as reach the brain. With `seven`, Rik and Sam too: seven who tell, as a
 * team needs before any of its results are shown (`teamMayClaim`).
 */
const team = async ({ seven = false } = {}) => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    team: `ops-${id}`,
    lea: `lea-${id}`,
    max: `max-${id}`,
    mia: `mia-${id}`,
    mo: `mo-${id}`,
    noor: `noor-${id}`,
    pim: `pim-${id}`,
    rik: `rik-${id}`,
    sam: `sam-${id}`,
  };
  const names: Record<Key, [string, string]> = {
    lea: ["Lea Lind", "Team lead"],
    max: ["Max Mol", "Agent"],
    mia: ["Mia Moor", "Agent"],
    mo: ["Mo Mertens", "Agent"],
    noor: ["Noor Nijs", "Agent"],
    pim: ["Pim Peeters", "Agent"],
    rik: ["Rik Ras", "Agent"],
    sam: ["Sam Sol", "Agent"],
  };
  const keys: Key[] = [
    "lea",
    "max",
    "mia",
    "mo",
    "noor",
    "pim",
    ...(seven ? (["rik", "sam"] as const) : []),
  ];
  const roster: Roster = {
    teams: [{ id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false }],
    people: keys.map((key) => ({
      id: ids[key],
      name: names[key][0],
      team: ids.team,
      email: `${ids[key]}@acme.test`,
      title: names[key][1],
      away: false,
    })),
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  return ids;
};

type Ids = Awaited<ReturnType<typeof team>>;

/** Someone's link opened signed in as them: its secret and the session. */
const openLink = async (person: string) => {
  const link = await onboardingStore(env).linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const { link: device } = await openLinkAs(
    secret,
    await signedInAs(`${person}@acme.test`)
  );
  return device;
};

/** A fact as agreed. */
const fact = (id: string, tag: FactTag, record: string): InterviewFact => ({
  id,
  tag,
  text: `You said: ${record}`,
  record,
  agreed: true,
});

/** Saves someone's interview as agreed to, with `facts`, on `link` (opened anew unless given). */
const agree = async (
  person: string,
  facts: InterviewFact[],
  opened?: Awaited<ReturnType<typeof openLink>>
) => {
  const link = opened ?? (await openLink(person));
  const progress: InterviewProgress = {
    person: "completed",
    told: true,
    mode: "type",
    lines: [{ from: "stephen", text: "What starts one?" }],
    facts,
    phase: "readback",
    wants: "end",
    startedAt: Date.now(),
    confirmed: facts.length,
    adding: false,
    addedAt: 0,
  };
  const response = await onLink({
    action: "save",
    ...link,
    version: 0,
    progress,
  });
  const saved: InterviewSaved = await response.json();
  await approveAgreed(link, facts);
  return saved.version;
};

/** The map: tickets, by Max, Mia and Mo, and the rota, Lea's own; the team said to do `does`. */
const mapReply = (
  ids: Ids,
  does = "Answers customers' questions"
): ProviderReply => ({
  text: JSON.stringify({
    does,
    works: [
      {
        name: "handling new tickets",
        local: "nieuwe tickets afhandelen",
        one: "ticket",
        many: "tickets",
        doers: [ids.max, ids.mia, ids.mo],
        share: 0.8,
      },
      {
        name: "planning the rota",
        local: "het rooster plannen",
        one: "rota",
        many: "rotas",
        doers: [ids.lea],
        share: 0.2,
      },
    ],
  }),
  inputTokens: 2000,
  outputTokens: 300,
});

/** Tickets as drawn, with `tool` as the tool of each step: a model takes up what its context names. */
const ticketsReply = (ids: Ids, tool: string): Answer => ({
  text: JSON.stringify({
    starts: `A customer email arrives as a ticket in ${tool}.`,
    starts_by: [ids.max],
    steps: [
      {
        // All five told it, in the words of the document's reading, so it
        // reaches the brain (GRA-1084).
        text: `Open the ticket in ${tool}.`,
        who: "Agent",
        tool,
        by: [ids.max, ids.mia, ids.mo, ids.noor, ids.pim],
        minutes: [1, 2, 5],
      },
      { text: "Send the answer.", who: "Agent", tool, by: [ids.mia] },
    ],
    notes: [
      { kind: "wait", text: "Waits for the customer's reply.", by: [ids.mo] },
    ],
    numbers: [],
    open: [`Who checks what ${tool} holds?`],
  }),
  inputTokens: 4000,
  outputTokens: 900,
});

/** The rota as drawn, Lea's own. */
const rotaReply = (ids: Ids): ProviderReply => ({
  text: JSON.stringify({ steps: [{ text: "Plan the rota.", by: [ids.lea] }] }),
  inputTokens: 1,
  outputTokens: 1,
});

/**
 * Lea's map drawn and the rota out of the way, then Max, Mia, Mo, Noor and
 * Pim agree to what they told about tickets, Max that `maxSays`.
 */
const toldAll = async (ids: Ids, maxSays = "Tickets arrive in Zendesk.") => {
  const store = onboardingStore(env);
  await store.releaseDue();
  await agree(ids.lea, [
    fact("l1", "work", "Max, Mia and Mo handle new tickets."),
  ]);
  await answering([mapReply(ids)], async () => await store.drawNext());
  await store.releaseDue();
  await answering([rotaReply(ids)], async () => await store.drawNext());
  await agree(ids.max, [fact("m1", "system", maxSays)]);
  await agree(ids.mia, [fact("i1", "system", "Tickets arrive in Zendesk.")]);
  await agree(ids.mo, [
    fact("o1", "wait", "A ticket waits days for the customer's reply."),
  ]);
  await agree(ids.noor, [fact("n1", "step", "Reads the ticket first.")]);
  await agree(ids.pim, [fact("p1", "step", "Tags the ticket.")]);
};

/** What everyone of a team of seven (`team({ seven: true })`) tells: `toldAll`, and Rik and Sam a step each. */
const sevenTold = async (ids: Ids) => {
  await toldAll(ids);
  await agree(ids.rik, [fact("r1", "step", "Checks the queue at noon.")]);
  await agree(ids.sam, [fact("s1", "step", "Answers the phone.")]);
};

/** What `run` returns while the provider answers each request with what `respond` makes. */
const answeringWith = async <T>(
  respond: () => Promise<ProviderReply>,
  run: () => Promise<T>
): Promise<T> => {
  const { result } = await answeringWithRequests(respond, run);
  return result;
};

/**
 * A reply naming the purged word for the first request only, the drawing
 * already under way as the purge lands (chosen as each request arrives,
 * before it waits on the purge); `clean` for every one after. Any
 * drawing after the purge (the store's own alarm, which the purge arms,
 * may draw again while the test still answers the provider) reads what the
 * purge left, so a model would never give the word back: answering it
 * with the word would put it back in the store, and the test would race
 * that alarm.
 */
const namingFirst = (
  naming: () => ProviderReply,
  clean: () => ProviderReply
): (() => ProviderReply) => {
  let asked = false;
  return () => {
    const first = !asked;
    asked = true;
    return first ? naming() : clean();
  };
};

/** Draws whatever is due, the tickets with `tool`, until nothing is; whether a request carried `word`. */
const drawAll = async (ids: Ids, tool: string, word: string) => {
  const store = onboardingStore(env);
  const { requests } = await answeringWithRequests(
    (sent) =>
      JSON.stringify(sent.at(-1)?.body).includes("planning the rota")
        ? rotaReply(ids)
        : ticketsReply(ids, tool),
    async () => {
      for (let round = 0; round < 5; round += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one drawing at a time, as the alarm draws
        if ((await store.drawNext()) === null) {
          break;
        }
      }
    }
  );
  return JSON.stringify(requests.map(({ body }) => body))
    .toLowerCase()
    .includes(word);
};

/** Gives the brain team `ids`, as the alarm would once others due before it are given. */
const intakeOf = async (ids: Ids): Promise<void> => {
  for (let round = 0; round < 5; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one team at a time, as the alarm gives them
    const given = await intakeAlike();
    if (given === `brain:${ids.team}` || given === null) {
      return;
    }
  }
};

/** Where `word` is left: the store's tables, core's database, the audit log, interview turns, and what the admin and the brain show. */
const leftOf = async (admin: SessionApi, ids: Ids, word: string) => {
  const store = onboardingStore(env);
  const events = await allEvents();
  const brief = await store.documentsBrief("Ops");
  const contexts = await Promise.all(
    [ids.lea, ids.max].map(async (person) => await store.contextOf(person))
  );
  return {
    store: await onboardingTablesWith(word),
    core: await d1ColumnsWith(env.DB, word),
    audit: JSON.stringify(events).toLowerCase().includes(word),
    turns: JSON.stringify(contexts).toLowerCase().includes(word),
    shown: {
      documents: JSON.stringify(await admin.onboarding.documents())
        .toLowerCase()
        .includes(word),
      brief: brief.toLowerCase().includes(word),
      brain: JSON.stringify(await admin.brain.read())
        .toLowerCase()
        .includes(word),
    },
  };
};

/** The latest audit event of `action`'s detail, outboxes drained. */
const detailOf = async (action: string) => {
  const events = await allEvents();
  return events.findLast((event) => event.action === action)?.detail;
};

/** The tickets of `team` as the store holds them now. */
const ticketsOf = async (teamId: string) => {
  const works = await onboardingStore(env).teamWorks(teamId);
  return works.find(({ name }) => name === "handling new tickets");
};

/** Tickets drawn naming `word`, from what Max said: the team and the tickets. */
const ticketsNaming = async (word: string) => {
  const ids = await team();
  await toldAll(ids, `Tickets arrive in Zendesk and ${word}.`);
  await answering(
    [ticketsReply(ids, word)],
    async () => await onboardingStore(env).drawNext()
  );
  const tickets = await ticketsOf(ids.team);
  if (tickets?.drawn === undefined || tickets.drawn === null) {
    throw new Error("The tickets weren't drawn");
  }
  return { ids, tickets: { id: tickets.id, drawnAt: tickets.drawn.at } };
};

/** Runs `sql` with `values` in the onboarding store's own database. */
const inStore = async (sql: string, ...values: SqlStorageValue[]) => {
  await runInDurableObject(onboardingStore(env), (_object, state) => {
    state.storage.sql.exec(sql, ...values);
  });
};

describe(
  "a document shared in the onboarding, as it is removed",
  { timeout: 180_000 },
  () => {
    // Each test draws step by step, as the alarm would: the store's own
    // alarm, which agreeing and purging set, would otherwise race it for
    // the drawing and the provider's replies (`holdAlarm`).
    beforeEach(holdAlarm);

    it.each([
      {
        how: "an admin removes it",
        go: async (admin: SessionApi, id: string) => {
          await admin.onboarding.removeDocument(id);
        },
      },
      {
        how: "the admin who shared it deletes its file from Brain › Sources",
        go: async (admin: SessionApi, id: string) => {
          await admin.brainSources.deleteUpload(id);
        },
      },
    ])(
      "takes its reading, the answer and every drawing made with it out of the store, both databases, the audit log and the turns when $how, and draws the work again",
      async ({ go }) => {
        const { api: admin } = await signedInApi(idp, "admin");
        const word = sentinelOf();
        const id = await share(admin, `removed-${unique()}.docx`, word);
        const ids = await team();
        await toldAll(ids);
        const drewWith = await drawAll(ids, word, word);
        await intakeAlike();
        const before = await leftOf(admin, ids, word);
        await go(admin, id);
        const removedDetail = await detailOf("onboarding.document.purged");
        const drewAgainWith = await drawAll(ids, "Zendesk", word);
        await intakeAlike();
        const after = await leftOf(admin, ids, word);
        const tickets = await ticketsOf(ids.team);
        expect({
          drewWith,
          before: before.shown,
          removed: removedDetail?.documents,
          drewAgainWith,
          after,
          drawnAgain: tickets?.drawn?.steps.map(({ tool }) => tool),
        }).toStrictEqual({
          drewWith: true,
          before: { documents: true, brief: true, brain: true },
          removed: 1,
          drewAgainWith: false,
          after: {
            store: [],
            core: [],
            audit: false,
            turns: false,
            shown: { documents: false, brief: false, brain: false },
          },
          drawnAgain: ["Zendesk", "Zendesk"],
        });
      }
    );

    it("lets a member delete an upload of their own while an intake holds the brain, without waiting for it", async () => {
      const member = await signedInApi(idp, "user");
      const upload = crypto.randomUUID();
      await member.api.brainSources.upload(
        { name: "Diary.docx", bytes: wordFile(["My own diary."]) },
        { kind: "me" },
        upload
      );
      const ids = await team();
      await toldAll(ids);
      await drawAll(ids, "Zendesk", sentinelOf());
      // An intake that holds the brain until the test lets its model answer.
      const intakeAsked = Promise.withResolvers<boolean>();
      const modelAnswers = Promise.withResolvers<boolean>();
      const intaking = answeringWithRequests(
        async (requests) => {
          intakeAsked.resolve(true);
          await modelAnswers.promise;
          return alikeReply(requests);
        },
        async () => await onboardingStore(env).intakeNext()
      );
      const state = { holding: false, deleted: false };
      void intakeAsked.promise.then(() => {
        state.holding = true;
      });
      try {
        await vi.waitFor(
          () => {
            expect(
              state.holding,
              "the intake never asked its model"
            ).toBeTruthy();
          },
          { timeout: 15_000, interval: 50 }
        );
        void member.api.brainSources.deleteUpload(upload).then(() => {
          state.deleted = true;
        });
        await vi.waitFor(
          () => {
            expect(
              state.deleted,
              "the delete waited for the intake"
            ).toBeTruthy();
          },
          { timeout: 5000, interval: 50 }
        );
      } finally {
        modelAnswers.resolve(true);
        await intaking;
      }
      expect(state).toStrictEqual({ holding: true, deleted: true });
    });

    it("takes a drawing made since the document was shared off the page and out of the new Brain as its removal answers", async () => {
      const { api: admin } = await signedInApi(idp, "admin");
      const word = sentinelOf();
      const id = await share(admin, `removed-${unique()}.docx`, word);
      const ids = await team({ seven: true });
      await sevenTold(ids);
      await drawAll(ids, word, word);
      await intakeOf(ids);
      const standing = async (): Promise<number> => {
        const drawings = await onboardingStore(env).standingDrawings();
        return drawings.filter(({ team: of }) => of === ids.team).length;
      };
      const work = async (): Promise<string[]> => {
        const { workflows } = await admin.brain.read();
        return workflows
          .filter(({ teamId }) => teamId === `team-${ids.team}`)
          .map(({ name }) => name);
      };
      const before = { standing: await standing(), page: await work() };
      await admin.onboarding.removeDocument(id);
      expect({
        before,
        after: { standing: await standing(), page: await work() },
      }).toStrictEqual({
        before: { standing: 1, page: ["handling new tickets"] },
        after: { standing: 0, page: [] },
      });
    });

    it("takes a drawing out of the new Brain on the removal's retry when taking it out failed the first time, before the reading goes", async () => {
      const { api: admin } = await signedInApi(idp, "admin");
      const member = await signedInApi(idp, "user");
      const word = sentinelOf();
      const id = await share(admin, `removed-${unique()}.docx`, word);
      const ids = await team({ seven: true });
      await sevenTold(ids);
      await drawAll(ids, word, word);
      await intakeOf(ids);
      // Handed to the new Brain, as core's clock does.
      await allEvents();
      await relayHandOvers(env);
      await workBrain(env, new Date(), producersOf(env));
      const drawingsFound = async (): Promise<number> => {
        const { items } = await recallAs(env, member.userId, {
          question: "ticket",
          budget: { tokens: 2000 },
          personal: true,
        });
        return items.filter(({ source }) => source.producer === "drawing")
          .length;
      };
      const before = await drawingsFound();
      // The Brain can't take it out of use the first time: the removal
      // fails, with the reading still there; the retry finds it again.
      const restore = await setObjectEnv(onboardingStore(env), {
        BRAIN_STORE: removalsFailingOnce().BRAIN_STORE,
      });
      let first: string;
      try {
        first = await outcome(admin.onboarding.removeDocument(id));
        await admin.onboarding.removeDocument(id);
      } finally {
        await restore();
      }
      const documents = await admin.onboarding.documents();
      expect({
        before: before > 0,
        first: first === "removed" ? "removed" : "refused",
        reading: documents.some((document) => document.id === id),
        after: await drawingsFound(),
      }).toStrictEqual({
        before: true,
        first: "refused",
        reading: false,
        after: 0,
      });
    });

    it("throws away a drawing under way as its document goes, and draws it again", async () => {
      const { api: admin } = await signedInApi(idp, "admin");
      const store = onboardingStore(env);
      const word = sentinelOf();
      const shared = await share(admin, `racing-${unique()}.docx`, word);
      const ids = await team();
      await toldAll(ids);
      let forgotten: number | undefined;
      const reply = namingFirst(
        () => ticketsReply(ids, word),
        () => ticketsReply(ids, "Zendesk")
      );
      // The document goes while the tickets are drawn with it: as the
      // drawing's request reaches the provider, inside the store's call.
      const drew = await answeringWith(
        async () => {
          // A stub of its own: the store's call is another I/O context.
          forgotten ??= await onboardingStore(env).forgetDocuments([shared], {
            type: "system",
          });
          return reply();
        },
        async () => await store.drawNext()
      );
      const tickets = await ticketsOf(ids.team);
      const left = await onboardingTablesWith(word);
      const drewAgainWith = await drawAll(ids, "Zendesk", word);
      expect({
        drew: drew?.startsWith("work:"),
        forgotten,
        thrown: tickets?.drawn ?? null,
        left,
        drewAgainWith,
      }).toStrictEqual({
        drew: true,
        forgotten: 1,
        thrown: null,
        left: [],
        drewAgainWith: false,
      });
    });
  }
);

describe(
  "what was drawn, as a work is drawn again",
  { timeout: 120_000 },
  () => {
    beforeEach(holdAlarm);

    it("drops a work's checked difference when the work is drawn again", async () => {
      const word = sentinelOf();
      const { ids, tickets } = await ticketsNaming(word);
      // A difference checked in the drawing, naming the word.
      await inStore(
        "INSERT INTO checked_differences (work, drawn_at, way, other, at) VALUES (?, ?, ?, ?, ?)",
        tickets.id,
        tickets.drawnAt,
        `It arrives in ${word}.`,
        "It arrives by mail.",
        new Date().toISOString()
      );
      const before = await onboardingTablesWith(word);

      await onboardingStore(env).drawWorkAgain(tickets.id, { type: "system" });
      await drawAll(ids, "Zendesk", word);
      const after = await onboardingTablesWith(word);

      expect({
        before: before.includes("checked_differences"),
        after: after.includes("checked_differences"),
      }).toStrictEqual({ before: true, after: false });
    });
  }
);
