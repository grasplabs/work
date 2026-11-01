import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { Roster } from "@grasp-os/shared/onboarding";
import type { SessionApi } from "@grasp-os/shared/rpc";
import { speechPath } from "@grasp-os/shared/voice";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  drawingErasure,
  interviewErasure,
} from "../src/onboarding/interview-erasure.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { platformAi } from "../src/platform-ai.ts";
import { keptLine } from "../src/speech-cache.ts";
import { allEvents } from "./audit-events.ts";
import { platformElevenLabsKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  answering,
  answeringWith as answeringWithRequests,
  approveAgreed,
  holdAlarm,
} from "./interview-link.ts";
import type { Answer, ProviderReply } from "./model-provider.ts";
import { intakeAlike } from "./onboarding-team.ts";
import {
  carrying,
  plan as planReplies,
  release,
} from "./platform-providers.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { wordFile } from "./word-file.ts";

// A document shared in the onboarding, purged from Knowledge (GRA-970,
// onboarding/documents.ts `documentReadingErasure`, the store's
// `forgetDocuments`). Each document here holds a word nobody else says (a
// sentinel), which its reading, the admin's answer and a drawing take up,
// and the tests look for it everywhere it could be left: the store's
// tables, both D1 databases, the audit log, and what an interview turn
// knows. The model provider is the outside system, faked behind connect.
// The ways it can fail, tried here:
//
// - The reading living on after its document is purged, in Stephen's
//   context, the admin's list or the brain's sources and tools.
// - A drawing made with the reading for context left in the store or in
//   the brain, or not drawn again.
// - The purge in the audit log with any of the document's words.
// - A reading holding a purged term of a document the purge doesn't name.
// - A drawing under way as the document goes, kept as it ends.

/** The speech model lines are said in: the platform's default. */
const speechModel = `${platformAi.speech.provider}/${platformAi.speech.model}`;
const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sessionKey = z.object({ key: z.string().optional() });

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

/** Shares a document named `name` holding `word`, as `admin`, answers its question, and waits for Knowledge to hold it. */
const share = async (
  admin: SessionApi,
  name: string,
  word: string
): Promise<{ upload: string; document: string }> => {
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
  const document = await vi.waitFor(
    async () => {
      const upload = await admin.uploads.get(shared.id);
      if (upload.documentId === null) {
        throw new Error(`Upload ${shared.id} is ${upload.status}`);
      }
      return upload.documentId;
    },
    { timeout: 20_000, interval: 100 }
  );
  return { upload: shared.id, document };
};

/** Purges `terms` from `documentIds`, as `admin`. */
const purge = async (
  admin: SessionApi,
  documentIds: string[],
  terms: string[]
) => {
  const input = {
    type: "content" as const,
    documentIds,
    terms,
    reason: "erasure_request" as const,
  };
  const plan = await admin.knowledge.preparePurge(input);
  return await admin.knowledge.purge(input, plan.token);
};

/** The people of a team, by key. */
type Key = "lea" | "max" | "mia" | "mo" | "noor" | "pim";

/** A team called Ops, led by Lea, with Max, Mia, Mo, Noor and Pim, in an onboarding that started yesterday: five who tell their own work, as many as reach the brain. */
const team = async () => {
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
  };
  const names: Record<Key, [string, string]> = {
    lea: ["Lea Lind", "Team lead"],
    max: ["Max Mol", "Agent"],
    mia: ["Mia Moor", "Agent"],
    mo: ["Mo Mertens", "Agent"],
    noor: ["Noor Nijs", "Agent"],
    pim: ["Pim Peeters", "Agent"],
  };
  const keys: Key[] = ["lea", "max", "mia", "mo", "noor", "pim"];
  const roster: Roster = {
    teams: [{ id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false }],
    people: keys.map((key) => ({
      id: ids[key],
      name: names[key][0],
      team: ids.team,
      email: "",
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

/** Someone's link opened on a device: their secret and key. */
const openLink = async (person: string) => {
  const link = await onboardingStore(env).linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const session = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = sessionKey.parse(await session.json());
  return { secret, key: key ?? "" };
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
  const response = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save", ...link, version: 0, progress }),
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

/** The store's tables that hold `word`. */
const storeTablesWith = async (word: string): Promise<string[]> =>
  await runInDurableObject(onboardingStore(env), (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'"
      )
      .toArray()
      .map(({ name }) => name)
      .filter((table) =>
        JSON.stringify(
          state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()
        )
          .toLowerCase()
          .includes(word)
      )
  );

/** `text`'s UTF-8 bytes in hex, as SQLite's `hex()` writes them. */
const hexOf = (text: string): string =>
  [...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

/** Every `table.column` of `db` that holds `word`, as text or among a row's bytes. */
const d1ColumnsWith = async (
  db: D1Database,
  word: string
): Promise<string[]> => {
  const { results: tables } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
    )
    .all<{ name: string }>();
  const found: string[] = [];
  for (const { name: table } of tables) {
    // oxlint-disable-next-line no-await-in-loop -- one table at a time
    const { results: columns } = await db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .bind(table)
      .all<{ name: string }>();
    for (const { name: column } of columns) {
      // oxlint-disable-next-line no-await-in-loop -- one column at a time
      const row = await db
        .prepare(
          `SELECT count(*) AS n FROM "${table}"
           WHERE instr(lower(CAST("${column}" AS TEXT)), ?) > 0
             OR instr(hex("${column}"), ?) > 0`
        )
        .bind(word, hexOf(word))
        .first<{ n: number }>();
      if ((row?.n ?? 0) > 0) {
        found.push(`${table}.${column}`);
      }
    }
  }
  return found;
};

/** Whether Knowledge's words index still finds `word` as a token: its pages don't keep it in one piece. */
const indexFinds = async (word: string): Promise<boolean> =>
  (await env.KNOWLEDGE.prepare(
    "SELECT 1 AS held FROM search_words WHERE search_words MATCH ? LIMIT 1"
  )
    .bind(`"${word}"`)
    .first()) !== null;

/** Where `word` is left: the store's tables, both databases, the audit log, interview turns, and what the admin and the brain show. */
const leftOf = async (admin: SessionApi, ids: Ids, word: string) => {
  const store = onboardingStore(env);
  const events = await allEvents();
  const brief = await store.documentsBrief("Ops");
  const contexts = await Promise.all(
    [ids.lea, ids.max].map(async (person) => await store.contextOf(person))
  );
  return {
    store: await storeTablesWith(word),
    core: await d1ColumnsWith(env.DB, word),
    knowledge: [
      ...(await d1ColumnsWith(env.KNOWLEDGE, word)),
      ...((await indexFinds(word)) ? ["search_words"] : []),
    ],
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

/**
 * `database`, but a statement reading `table` first runs `hook`: what
 * happens as a read of it is under way.
 */
const withHook = (
  database: D1Database,
  table: string,
  hook: () => Promise<void>
): D1Database => {
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(prepared, {
      get: (target, name, receiver): unknown => {
        if (name === "bind") {
          return (...values: unknown[]) => statement(target.bind(...values));
        }
        if (name === "all" || name === "raw" || name === "first") {
          const run: unknown = Reflect.get(target, name, target);
          return async (...args: unknown[]): Promise<unknown> => {
            await hook();
            return typeof run === "function"
              ? await Reflect.apply(run, target, args)
              : undefined;
          };
        }
        return Reflect.get(target, name, receiver);
      },
    });
  return new Proxy(database, {
    get: (target, name, receiver): unknown => {
      if (name === "prepare") {
        return (query: string) => {
          const prepared = target.prepare(query);
          return query.includes(`"${table}"`) ? statement(prepared) : prepared;
        };
      }
      return Reflect.get(target, name, receiver);
    },
  });
};

/** The tickets of `team` as the store holds them now. */
const ticketsOf = async (teamId: string) => {
  const works = await onboardingStore(env).teamWorks(teamId);
  return works.find(({ name }) => name === "handling new tickets");
};

/**
 * The drawing erasure, as a purge runs it, with `meanwhile` landing after
 * it read what was drawn and before its write.
 */
const drawingErasureWith = (meanwhile: () => Promise<void>) => {
  const store = onboardingStore(env);
  let ran = false;
  const racing = (stub: typeof store): typeof store =>
    new Proxy(stub, {
      get: (target, name, receiver): unknown => {
        if (name !== "forgetDrawings") {
          return Reflect.get(target, name, receiver);
        }
        return async (
          ...args: Parameters<typeof store.forgetDrawings>
        ): Promise<void> => {
          if (!ran) {
            ran = true;
            await meanwhile();
          }
          await target.forgetDrawings(...args);
        };
      },
    });
  const namespace = (real: typeof env.ONBOARDING): typeof env.ONBOARDING =>
    new Proxy(real, {
      get: (target, name, receiver): unknown => {
        if (name === "getByName") {
          return (id: string) => racing(target.getByName(id));
        }
        if (name === "jurisdiction") {
          return (where: DurableObjectJurisdiction) =>
            namespace(target.jurisdiction(where));
        }
        return Reflect.get(target, name, receiver);
      },
    });
  return {
    ran: () => ran,
    erasure: drawingErasure({
      DURABLE_OBJECT_JURISDICTION: env.DURABLE_OBJECT_JURISDICTION,
      ONBOARDING: namespace(env.ONBOARDING),
    }),
  };
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
  "a document shared in the onboarding, purged from Knowledge",
  { timeout: 180_000 },
  () => {
    // Each test draws step by step, as the alarm would: the store's own
    // alarm, which agreeing and purging set, would otherwise race it for
    // the drawing and the provider's replies (`holdAlarm`).
    beforeEach(holdAlarm);

    it("takes its reading, the answer and every drawing made with it out of the store, both databases, the audit log and the turns, and draws the work again", async () => {
      const { api: admin } = await signedInApi(idp, "admin");
      const word = sentinelOf();
      const shared = await share(admin, `claims-${unique()}.docx`, word);
      const ids = await team();
      await toldAll(ids);
      const drewWith = await drawAll(ids, word, word);
      await intakeAlike();
      const before = await leftOf(admin, ids, word);
      const purged = await purge(admin, [shared.document], [word]);
      const purgedDetail = await detailOf("onboarding.document.purged");
      const recordsDetail = await detailOf("brain.records.purged");
      const drewAgainWith = await drawAll(ids, "Zendesk", word);
      await intakeAlike();
      const after = await leftOf(admin, ids, word);
      const tickets = await ticketsOf(ids.team);
      expect({
        drewWith,
        before: {
          store: before.store.toSorted(),
          core: before.core.length > 0,
          turns: before.turns,
          shown: before.shown,
        },
        stillFound: purged.stillFound,
        purgedDetail,
        records: recordsDetail?.purged,
        drewAgainWith,
        after,
        drawnAgain: tickets?.drawn?.steps.map(({ tool }) => tool),
      }).toStrictEqual({
        drewWith: true,
        before: {
          store: ["documents", "drawn_works"],
          core: true,
          turns: true,
          shown: { documents: true, brief: true, brain: true },
        },
        stillFound: 0,
        // The drawing that named the word went with the interviews'
        // drawings, before the readings; the other drawn with the
        // document goes with it.
        purgedDetail: { documents: 1, drawings: 1, records: 1 },
        records: 1,
        drewAgainWith: false,
        after: {
          store: [],
          core: [],
          knowledge: [],
          audit: false,
          turns: false,
          shown: { documents: false, brief: false, brain: false },
        },
        drawnAgain: ["Zendesk", "Zendesk"],
      });
    });

    it("forgets a reading holding a purged term of a document it doesn't name, and keeps one holding none", async () => {
      const { api: admin } = await signedInApi(idp, "admin");
      const word = sentinelOf();
      const other = sentinelOf();
      const named = await share(admin, `named-${unique()}.docx`, other);
      const holding = await share(admin, `holding-${unique()}.docx`, word);
      const kept = await share(admin, `kept-${unique()}.docx`, sentinelOf());
      const plan = await admin.knowledge.preparePurge({
        type: "content",
        documentIds: [named.document],
        terms: [word],
        reason: "erasure_request",
      });
      await purge(admin, [named.document], [word]);
      const documents = await admin.onboarding.documents();
      const listed = new Set(documents.map(({ id }) => id));
      expect({
        hostCopies: plan.hostCopies,
        named: listed.has(named.upload),
        holding: listed.has(holding.upload),
        kept: listed.has(kept.upload),
        left: await storeTablesWith(word),
      }).toStrictEqual({
        hostCopies: 1,
        named: false,
        holding: false,
        kept: true,
        left: [],
      });
    });

    it("throws away a drawing under way as a purge rewrites what its people said, while its brief is read or its drawing asked for, and draws it again", async () => {
      const store = onboardingStore(env);
      /**
       * Tickets drawn from what Max said, naming a word, while a content
       * purge of it reaches the interviews `when`: as the brief reads the
       * company's name, or as the drawing's request reaches the provider,
       * each inside the store's call.
       */
      const purgedWhile = async (when: "brief" | "drawing") => {
        const word = sentinelOf();
        const ids = await team();
        await toldAll(ids, `Tickets arrive in Zendesk and ${word}.`);
        let purged = false;
        const purgeOnce = async () => {
          if (!purged) {
            purged = true;
            await interviewErasure(env).rewrite(
              { actor: { type: "system" }, userId: "system" },
              (text) => text.replaceAll(word, "(removed)")
            );
          }
        };
        const database = env.DB;
        if (when === "brief") {
          env.DB = withHook(database, "organizations", purgeOnce);
        }
        const reply = namingFirst(
          () => ticketsReply(ids, word),
          () => ticketsReply(ids, "Zendesk")
        );
        try {
          const drew = await answeringWith(
            async () => {
              if (when === "drawing") {
                await purgeOnce();
              }
              return reply();
            },
            async () => await store.drawNext()
          );
          const tickets = await ticketsOf(ids.team);
          env.DB = database;
          return {
            drew: drew?.startsWith("work:"),
            purged,
            // The drawing made from what Max said before: thrown away.
            thrown: JSON.stringify(tickets?.drawn ?? null).includes(word),
            left: await storeTablesWith(word),
            drewAgainWith: await drawAll(ids, "Zendesk", word),
          };
        } finally {
          env.DB = database;
        }
      };
      const whole = {
        drew: true,
        purged: true,
        thrown: false,
        left: [],
        drewAgainWith: false,
      };

      expect({
        brief: await purgedWhile("brief"),
        drawing: await purgedWhile("drawing"),
      }).toStrictEqual({ brief: whole, drawing: whole });
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
          forgotten ??= await onboardingStore(env).forgetDocuments(
            [shared.upload],
            { type: "system" }
          );
          return reply();
        },
        async () => await store.drawNext()
      );
      const tickets = await ticketsOf(ids.team);
      const left = await storeTablesWith(word);
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

/**
 * The onboarding's part of a content purge of `word`, once, however often
 * it's asked: the interviews rewritten, then what was drawn from them. A
 * stub of its own each time: it runs inside another call's I/O context.
 */
const purgeOnce = (word: string) => {
  let ran = false;
  return {
    ran: () => ran,
    once: async () => {
      if (ran) {
        return;
      }
      ran = true;
      const by = { actor: { type: "system" }, userId: "system" } as const;
      const rewrite = (text: string) => text.replaceAll(word, "(removed)");
      await interviewErasure(env).rewrite(by, rewrite);
      await drawingErasure(env).rewrite(by, rewrite);
    },
  };
};

/** One way the onboarding writes what it made from what people said. */
interface Writer {
  name: string;
  /**
   * Starts writing from something naming `word`, with a purge (`landing`)
   * while it's under way, and returns where `word` is left after.
   */
  run: (
    word: string,
    landing: ReturnType<typeof purgeOnce>
  ) => Promise<unknown>;
}

// Every writer whose output rests on interview or kickoff text, each made
// to run while a purge lands (the kickoff's reading: brain.test.ts).
const writers: Writer[] = [
  {
    name: "a piece of work's drawing",
    run: async (word, landing) => {
      const ids = await team();
      await toldAll(ids, `Tickets arrive in Zendesk and ${word}.`);
      const reply = namingFirst(
        () => ticketsReply(ids, word),
        () => ticketsReply(ids, "Zendesk")
      );
      await answeringWith(
        async () => {
          // Chosen as the request arrives, before the purge it waits on:
          // only the drawing already under way is answered with the word.
          const answer = reply();
          await landing.once();
          return answer;
        },
        async () => await onboardingStore(env).drawNext()
      );
      return await storeTablesWith(word);
    },
  },
  {
    name: "a team's map",
    run: async (word, landing) => {
      const ids = await team();
      const store = onboardingStore(env);
      await store.releaseDue();
      await agree(ids.lea, [
        fact("l1", "work", `Max, Mia and Mo handle tickets about ${word}.`),
      ]);
      const reply = namingFirst(
        () => mapReply(ids, `Answers questions about ${word}`),
        () => mapReply(ids, "Answers questions")
      );
      await answeringWith(
        async () => {
          // Chosen as the request arrives, before the purge it waits on:
          // only the drawing already under way is answered with the word.
          const answer = reply();
          await landing.once();
          return answer;
        },
        async () => await store.drawNext()
      );
      return await storeTablesWith(word);
    },
  },
  {
    name: "a line Stephen says, kept in the speech cache",
    run: async (word, landing) => {
      const ids = await team();
      await onboardingStore(env).releaseDue();
      // The lead: the first whose link is out.
      const told = fact("l1", "work", `Tickets arrive in ${word}.`);
      const link = await openLink(ids.lea);
      await agree(ids.lea, [told], link);
      // ElevenLabs says the line once the purge has landed meanwhile.
      const held = `line-${unique()}`;
      await planReplies(platformElevenLabsKey, [{ release: held }]);
      const saying = routed(speechPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: told.text, language: "en", link }),
      });
      await vi.waitFor(async () => {
        await expect(carrying(told.text)).resolves.toHaveLength(1);
      });
      await landing.once();
      await release(held);
      const said = await saying;
      await said.body?.cancel();
      const kept = await keptLine(env, {
        text: told.text,
        spoken: told.text,
        voice: platformAi.speech.voices.stephen,
        model: speechModel,
        language: "en",
      });
      return kept === undefined ? [] : ["speech cache"];
    },
  },
];

describe(
  "a writer under way as a content purge lands",
  { timeout: 60_000 },
  () => {
    // Each writer runs as the alarm would: the store's own alarm, which
    // agreeing and the purge set, would otherwise draw beside it, after
    // the purge, and race it for the provider's replies (`holdAlarm`).
    beforeEach(holdAlarm);

    it.each(writers)("keeps nothing purged: $name", async ({ run }) => {
      const word = sentinelOf();
      const landing = purgeOnce(word);

      const left = await run(word, landing);

      expect({ purged: landing.ran(), left }).toStrictEqual({
        purged: true,
        left: [],
      });
    });
  }
);

describe(
  "what was drawn, as a purge and a new drawing cross",
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
      const before = await storeTablesWith(word);

      await onboardingStore(env).drawWorkAgain(tickets.id, { type: "system" });
      await drawAll(ids, "Zendesk", word);
      const after = await storeTablesWith(word);

      expect({
        before: before.includes("checked_differences"),
        after: after.includes("checked_differences"),
      }).toStrictEqual({ before: true, after: false });
    });

    it("leaves a drawing and a work's name as made again between the purge's read and its write, and counts nothing it left", async () => {
      const word = sentinelOf();
      const { ids, tickets } = await ticketsNaming(word);
      await inStore(
        "UPDATE works SET name = ? WHERE id = ?",
        `handling new tickets in ${word}`,
        tickets.id
      );
      const store = onboardingStore(env);
      const { ran, erasure } = drawingErasureWith(async () => {
        // Drawn again, and named again, from clean words.
        await store.drawWorkAgain(tickets.id, { type: "system" });
        await drawAll(ids, "Zendesk", word);
        await inStore(
          "UPDATE works SET name = ? WHERE id = ?",
          "handling new tickets",
          tickets.id
        );
      });

      await erasure.rewrite(
        { actor: { type: "system" }, userId: "system" },
        (text) => text.replaceAll(word, "(removed)")
      );
      const after = await ticketsOf(ids.team);

      expect({
        ran: ran(),
        name: after?.name,
        tools: after?.drawn?.steps.map(({ tool }) => tool),
        counted: await detailOf("onboarding.drawings.purged"),
      }).toMatchObject({
        ran: true,
        name: "handling new tickets",
        tools: ["Zendesk", "Zendesk"],
        counted: { drawings: 0, works: 0, teams: 0 },
      });
    });

    it("leaves a checked difference checked anew between the purge's read and its write, and counts none it left", async () => {
      const word = sentinelOf();
      const { ids, tickets } = await ticketsNaming(word);
      const difference = async (way: string) => {
        await inStore(
          "INSERT INTO checked_differences (work, drawn_at, way, other, at) VALUES (?, ?, ?, ?, ?)",
          tickets.id,
          tickets.drawnAt,
          way,
          "It arrives by mail.",
          new Date().toISOString()
        );
      };
      // A difference checked in the drawing, naming the word.
      await difference(`It arrives in ${word}.`);
      const store = onboardingStore(env);
      const clean = "It arrives in Zendesk.";
      const { ran, erasure } = drawingErasureWith(async () => {
        // Drawn again from clean words, which drops the old difference, and
        // a new one checked in the new drawing.
        await store.drawWorkAgain(tickets.id, { type: "system" });
        await drawAll(ids, "Zendesk", word);
        await difference(clean);
      });

      await erasure.rewrite(
        { actor: { type: "system" }, userId: "system" },
        (text) => text.replaceAll(word, "(removed)")
      );
      const left = await runInDurableObject(store, (_object, state) =>
        state.storage.sql
          .exec<{ way: string }>(
            "SELECT way FROM checked_differences WHERE work = ?",
            tickets.id
          )
          .toArray()
          .map(({ way }) => way)
      );

      expect({
        ran: ran(),
        left,
        counted: await detailOf("onboarding.drawings.purged"),
      }).toMatchObject({
        ran: true,
        left: [clean],
        counted: { drawings: 0, differences: 0 },
      });
    });
  }
);
