import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
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
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { answeringGateway, fakeGateway } from "./ai-gateway.ts";
import type { Answer, GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { answering, approveAgreed, gatewayConfig } from "./interview-link.ts";
import { intakeAlike } from "./onboarding-team.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { wordFile } from "./word-file.ts";

// A document shared in the onboarding, purged from the Brain (GRA-970,
// onboarding/documents.ts `documentReadingErasure`, the store's
// `forgetDocuments`). Each document here holds a word nobody else says (a
// sentinel), which its reading, the admin's answer and a drawing take up,
// and the tests look for it everywhere it could be left: the store's
// tables, both D1 databases, the audit log, and what an interview turn
// knows. AI Gateway is the outside system, faked behind the AI binding.
// The ways it can fail, tried here:
//
// - The reading living on after its document is purged, in Stephen's
//   context, the admin's list or the brain's sources and tools.
// - A drawing made with the reading for context left in the store or in
//   the brain, or not drawn again.
// - The purge in the audit log with any of the document's words.
// - A reading holding a purged term of a document the purge doesn't name.
// - A drawing under way as the document goes, kept as it ends.

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
const readingWith = (word: string): GatewayReply => ({
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

/** Shares a document named `name` holding `word`, as `admin`, answers its question, and waits for Brain to hold it. */
const share = async (
  admin: SessionApi,
  name: string,
  word: string
): Promise<{ upload: string; document: string }> => {
  const fake = fakeGateway(readingWith(word));
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  let shared: { id: string };
  try {
    shared = await admin.onboarding.shareDocument({
      locale: "en",
      name,
      bytes: documentWith(word),
    });
  } finally {
    spy.mockRestore();
  }
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
  const plan = await admin.brain.preparePurge(input);
  return await admin.brain.purge(input, plan.token);
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

/** Saves someone's interview as agreed to, with `facts`. */
const agree = async (person: string, facts: InterviewFact[]) => {
  const link = await openLink(person);
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

/** The map: tickets, by Max, Mia and Mo, and the rota, Lea's own. */
const mapReply = (ids: Ids): GatewayReply => ({
  text: JSON.stringify({
    does: "Answers customers' questions",
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
const rotaReply = (ids: Ids): GatewayReply => ({
  text: JSON.stringify({ steps: [{ text: "Plan the rota.", by: [ids.lea] }] }),
  inputTokens: 1,
  outputTokens: 1,
});

/** Lea's map drawn and the rota out of the way, then Max, Mia, Mo, Noor and Pim agree to what they told about tickets. */
const toldAll = async (ids: Ids) => {
  const store = onboardingStore(env);
  await store.releaseDue();
  await agree(ids.lea, [
    fact("l1", "work", "Max, Mia and Mo handle new tickets."),
  ]);
  await answering([mapReply(ids)], async () => await store.drawNext());
  await store.releaseDue();
  await answering([rotaReply(ids)], async () => await store.drawNext());
  await agree(ids.max, [fact("m1", "system", "Tickets arrive in Zendesk.")]);
  await agree(ids.mia, [fact("i1", "system", "Tickets arrive in Zendesk.")]);
  await agree(ids.mo, [
    fact("o1", "wait", "A ticket waits days for the customer's reply."),
  ]);
  await agree(ids.noor, [fact("n1", "step", "Reads the ticket first.")]);
  await agree(ids.pim, [fact("p1", "step", "Tags the ticket.")]);
};

/** What `run` returns while the gateway answers each request with what `respond` makes. */
const answeringWith = async <T>(
  respond: () => Promise<GatewayReply>,
  run: () => Promise<T>
): Promise<T> => {
  const gateway = answeringGateway(respond);
  const before = env.MODEL_GATEWAY;
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
  env.MODEL_GATEWAY = gatewayConfig;
  try {
    return await run();
  } finally {
    env.MODEL_GATEWAY = before;
    spy.mockRestore();
  }
};

/** Draws whatever is due, the tickets with `tool`, until nothing is; whether a request carried `word`. */
const drawAll = async (ids: Ids, tool: string, word: string) => {
  const store = onboardingStore(env);
  const gateway = answeringGateway((requests) =>
    JSON.stringify(requests.at(-1)?.body).includes("planning the rota")
      ? rotaReply(ids)
      : ticketsReply(ids, tool)
  );
  const before = env.MODEL_GATEWAY;
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
  env.MODEL_GATEWAY = gatewayConfig;
  try {
    for (let round = 0; round < 5; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one drawing at a time, as the alarm draws
      if ((await store.drawNext()) === null) {
        break;
      }
    }
  } finally {
    env.MODEL_GATEWAY = before;
    spy.mockRestore();
  }
  return JSON.stringify(gateway.requests.map(({ body }) => body))
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

/** Whether the Brain's words index still finds `word` as a token: its pages don't keep it in one piece. */
const indexFinds = async (word: string): Promise<boolean> =>
  (await env.BRAIN_DB.prepare(
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
    brain: [
      ...(await d1ColumnsWith(env.BRAIN_DB, word)),
      ...((await indexFinds(word)) ? ["search_words"] : []),
    ],
    audit: JSON.stringify(events).toLowerCase().includes(word),
    turns: JSON.stringify(contexts).toLowerCase().includes(word),
    shown: {
      documents: JSON.stringify(await admin.onboarding.documents())
        .toLowerCase()
        .includes(word),
      brief: brief.toLowerCase().includes(word),
      brain: JSON.stringify(await admin.brain.readWorkspace())
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

describe(
  "a document shared in the onboarding, purged from Brain",
  { timeout: 180_000 },
  () => {
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
        purgedDetail: { documents: 1, drawings: 2, records: 1 },
        records: 1,
        drewAgainWith: false,
        after: {
          store: [],
          core: [],
          brain: [],
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
      const plan = await admin.brain.preparePurge({
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

    it("throws away a drawing under way as its document goes, and draws it again", async () => {
      const { api: admin } = await signedInApi(idp, "admin");
      const store = onboardingStore(env);
      const word = sentinelOf();
      const shared = await share(admin, `racing-${unique()}.docx`, word);
      const ids = await team();
      await toldAll(ids);
      let forgotten: number | undefined;
      // The document goes while the tickets are drawn with it: as the
      // drawing's request reaches the gateway, inside the store's call.
      const drew = await answeringWith(
        async () => {
          // A stub of its own: the store's call is another I/O context.
          forgotten ??= await onboardingStore(env).forgetDocuments(
            [shared.upload],
            { type: "system" }
          );
          return ticketsReply(ids, word);
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
