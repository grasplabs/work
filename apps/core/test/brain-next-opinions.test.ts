import {
  companyOpinionIdPrefix,
  companyOpinionsSourceId,
} from "@grasp-os/shared/brain-records";
import type { Roster } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { drainObjectOutbox } from "../src/audit-outbox.ts";
import { recallAs, recallPassagesAs, workBrain } from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { companyMayHaveOpinions } from "../src/onboarding/company-opinions.ts";
import { Onboarding, onboardingStore } from "../src/onboarding/store.ts";
import { retryErasures } from "../src/person-erasure.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { mockIdp } from "./idp.ts";
import {
  accountOf,
  answeringWith,
  approveAgreed,
  holdAlarm,
  onLink,
  openLinkAs,
} from "./interview-link.ts";
import type { ProviderReply, SentRequest } from "./model-provider.ts";
import {
  agree,
  anonymous,
  fact,
  openLink,
  saveAgreed,
} from "./onboarding-team.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The company's opinions from the interviews (GRA-1987, rule 2): what
// people left only counted anonymously stands once five across the
// company back it, in a company where seven or more told such a line, and
// names no team. From the threat model on GRA-1987, the ways it can fail,
// tried here:
//
// - Five backers out of a company of six, or four backers anywhere, show
//   anything at all.
// - A team's or a person's name, or a count of anyone, reaching what a
//   member reads; a team's or a person's name reaching any model.
// - A backer's withdrawal, or a line moved to how their team works, leaving an
//   opinion readable after the change commits; and the change going
//   through while the Brain can't take it out.
// - Code (an App, a workflow, a chat's code) reading one, or telling that
//   one exists.

const idp = mockIdp();

const by = { type: "system" } as const;
const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The teams of the company, in order, and the names of their people. */
const teamNames = ["Finance", "Sales", "IT"] as const;
const peopleNames = [
  ["Max Mol", "Mia Moor", "Mo Mertens"],
  ["Noor Nijs", "Pim Peeters", "Rik Rooms"],
  ["Sam Smit", "Ada Aerts", "Lea Lind"],
] as const;

/** The staff list the last `company` saved. */
const listed: { roster: Roster | null } = { roster: null };

/**
 * A company of teams of `sizes` people (at most three teams of three),
 * no team led, in a fresh onboarding that started yesterday: each
 * person's id, by team.
 */
const company = async (sizes: readonly number[]): Promise<string[][]> => {
  const run = unique();
  const teams = sizes.map((size, at) => ({
    id: `${(teamNames[at] ?? "team").toLowerCase()}-${run}`,
    name: teamNames[at] ?? "Team",
    people: Array.from({ length: size }, (_, index) => ({
      id: `p${at}${index}-${run}`,
      name: peopleNames[at]?.[index] ?? "Someone Else",
    })),
  }));
  const roster: Roster = {
    teams: teams.map(({ id, name }) => ({
      id,
      name,
      lead: null,
      does: "",
      off: false,
    })),
    people: teams.flatMap(({ id: team, people }) =>
      people.map(({ id, name }) => ({
        id,
        name,
        team,
        email: `${id}@acme.test`,
        title: "Agent",
        away: false,
      }))
    ),
  };
  const store = onboardingStore(env);
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  listed.roster = roster;
  await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  return teams.map(({ people }) => people.map(({ id }) => id));
};

/** What a request gave the model between `<tag>` and `</tag>`, parsed; none when it gave none. */
const dataOf = (request: SentRequest | undefined, tag: string): unknown => {
  const sent = JSON.stringify(request?.body ?? null);
  const found = new RegExp(`<${tag}>\\\\n(?<data>.*?)\\\\n</${tag}>`, "u").exec(
    sent
  );
  const data = found?.groups?.data;
  if (data === undefined) {
    return undefined;
  }
  const text: unknown = JSON.parse(`"${data}"`);
  return typeof text === "string" ? JSON.parse(text) : undefined;
};

const linesSchema = z.array(
  z.object({
    lines: z.array(z.object({ id: z.string(), text: z.string() })),
  })
);
const viewsSchema = z.array(z.object({ id: z.string(), text: z.string() }));
const checkSchema = z.object({ claim: z.string(), fact: z.string() });

/** The fake model's answer `value`. */
const reply = (value: unknown): ProviderReply => ({
  text: JSON.stringify(value),
  inputTokens: 1000,
  outputTokens: 200,
});

/** An opinion as the fake merge makes it: its kind, its words, and the candidates it cites by their words. */
interface FakeOpinion {
  kind: string;
  text: string;
  cites: readonly string[];
}

/**
 * The model putting the company's opinions together, faked: a team's
 * lines become the view of `views` whose `when` they hold; the merge
 * makes `opinions`, citing the views of the words they cite; every check
 * says yes unless `says` answers.
 */
const opinionsModel =
  ({
    views,
    opinions,
    says = () => true,
  }: {
    views: readonly { when: string; view: string }[];
    opinions: readonly FakeOpinion[];
    says?: (claim: string, fact: string) => boolean;
  }) =>
  (requests: readonly SentRequest[]): ProviderReply => {
    const request = requests.at(-1);
    const check = checkSchema.safeParse(dataOf(request, "data"));
    if (check.success) {
      return reply({ says: says(check.data.claim, check.data.fact) });
    }
    const lines = linesSchema.safeParse(dataOf(request, "lines"));
    if (lines.success) {
      const shown = lines.data.flatMap((person) => person.lines);
      return reply({
        candidates: views.map(({ when, view }) => ({
          text: view,
          lines: shown
            .filter(({ text }) => text.includes(when))
            .map(({ id }) => id),
        })),
      });
    }
    const shown = viewsSchema.parse(dataOf(request, "views") ?? []);
    return reply({
      opinions: opinions.map(({ kind, text, cites }) => ({
        kind,
        text,
        candidates: shown
          .filter((view) => cites.includes(view.text))
          .map(({ id }) => id),
      })),
    });
  };

/** The view the invoice lines make, and the opinion five of them back. */
const invoiceView = "Re-typing invoices by hand wastes time.";
const invoices: FakeOpinion = {
  kind: "timeSink",
  // "it" stays a word though a team is called IT.
  text: "Typing invoices in again by hand is slow, and it costs people time.",
  cites: [invoiceView],
};
const meetingView = "The weekly meeting runs too long.";

/** The faked model of most tests: lines on invoices and on the meeting, merged into the invoices opinion. */
const invoicesModel = opinionsModel({
  views: [
    { when: "invoice", view: invoiceView },
    { when: "meeting", view: meetingView },
  ],
  opinions: [invoices],
});

/** A line only counted anonymously, about invoices or the meeting. */
const said = (id: string, what: "invoice" | "meeting", words = "") =>
  anonymous(
    fact(
      id,
      "wish",
      what === "invoice"
        ? `Re-typing every invoice by hand is a waste${words}.`
        : `The weekly meeting goes on far too long${words}.`
    )
  );

/**
 * Runs the company's opinions as the alarm does once the day is over,
 * with `model` answering: each team's candidates, then the merge. What it
 * did, and every request the model got.
 */
const formOpinions = async (
  model: (requests: readonly SentRequest[]) => ProviderReply
) => {
  const store = onboardingStore(env);
  const ran: string[] = [];
  const tomorrow = Date.now() + dayMs + 60_000;
  const { requests } = await answeringWith(model, async () => {
    // At most a run a team, and the merge.
    for (let run = 0; run < 10; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time, as the alarm runs them
      const did = await store.opinionsNext(tomorrow);
      if (did === null) {
        return;
      }
      ran.push(did);
      if (did === "opinions") {
        return;
      }
    }
  });
  return { ran, requests };
};

/** The queue's clock across this file: only forward, as core's clock goes. */
const clock = { at: Date.now() };

/** Hands over what the onboarding noted, as core does (brain-next-interviews.test.ts). */
const handOverNow = async (): Promise<void> => {
  await runInDurableObject(onboardingStore(env), async (_, state) => {
    await drainObjectOutbox(env, state.storage.sql, 0);
  });
  await relayHandOvers(env);
  clock.at = Math.max(clock.at, Date.now()) + 1;
  await workBrain(env, new Date(clock.at), producersOf(env));
};

/** What `userId` recalls of `word` from the company's opinions, reading as themselves. */
const opinionsRecalled = async (
  userId: string,
  word: string
): Promise<string[]> => {
  const { items } = await recallAs(env, userId, {
    question: word,
    budget: { tokens: 2000 },
    personal: true,
  });
  return items
    .filter(({ source }) => source.producer === "opinion")
    .map(({ text }) => text);
};

/** The account `person`'s link opened under. */
const accountOfPerson = async (person: string): Promise<string> =>
  await accountOf(await openLink(person));

/** What a member who told nothing reads on the Brain page of the company's opinions: the statements and their one source. */
const onThePage = async () => {
  const member = await signedInApi(idp, "user");
  const brain = await member.api.brain.read();
  return {
    statements: brain.statements.filter(({ id }) =>
      id.startsWith(companyOpinionIdPrefix)
    ),
    source: brain.sources.find(({ id }) => id === companyOpinionsSourceId),
  };
};

/** The words of the company's opinions on the Brain page, as a member who told nothing reads them. */
const pageOpinions = async (): Promise<string[]> => {
  const { statements } = await onThePage();
  return statements.map(({ text }) => text);
};

/** How many of the company's opinions `userId` recalls of `word`. */
const recalledCount = async (userId: string, word: string): Promise<number> => {
  const recalled = await opinionsRecalled(userId, word);
  return recalled.length;
};

/**
 * Code's recall as brain-recall.ts asks it, for `person`: an App's and a
 * workflow's as the company, a chat's code as its person's teams, never
 * as the person; read before that module's own narrowing.
 */
const codeReads = async (person: string) =>
  await Promise.all(
    [true, false].map(
      async (companyReach) =>
        await recallPassagesAs(env, person, {
          question: "invoices typing by hand time",
          budget: { tokens: 2000 },
          personal: false,
          company: companyReach,
          teams: [],
        })
    )
  );

/** The shared store refusing every removal, as while a restore runs: undone by the function returned. */
const restoring = async (): Promise<() => Promise<void>> => {
  const shared = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
  const restore = `restore-${unique()}`;
  await runInDurableObject(shared, (_, state) => {
    state.storage.sql.exec(
      "INSERT INTO restores (export, checked, part, restored, state, started_at) VALUES (?, 0, 0, 0, 'running', ?)",
      restore,
      Date.now()
    );
  });
  return async () => {
    await runInDurableObject(shared, (_, state) => {
      state.storage.sql.exec("DELETE FROM restores WHERE export = ?", restore);
    });
  };
};

/** Rows of the onboarding's own store, as `sql` reads them. */
const rowsOf = async (
  sql: string,
  ...bindings: string[]
): Promise<Record<string, unknown>[]> =>
  await runInDurableObject(onboardingStore(env), (_, state) =>
    state.storage.sql.exec(sql, ...bindings).toArray()
  );

/** Every row of the opinions' own tables that names `person`. */
const rowsNaming = async (person: string) => ({
  backers: await rowsOf(
    "SELECT record FROM opinion_backers WHERE person = ?",
    person
  ),
  candidates: await rowsOf(
    "SELECT id FROM opinion_candidates WHERE person = ?",
    person
  ),
  people: await rowsOf(
    "SELECT person FROM opinion_people WHERE person = ?",
    person
  ),
});

/** Who the standing opinion `text` rests on, sorted. */
const backersOf = async (text: string): Promise<string[]> => {
  const rows = await rowsOf(
    `SELECT b.person AS person FROM opinion_backers b
       JOIN brain_opinions o ON o.record = b.record
      WHERE o.text = ? AND o.erase = 0`,
    text
  );
  return rows.map(({ person }) => String(person)).toSorted();
};

/** How many the invoices opinion rests on now. */
const backerCount = async (): Promise<number> => {
  const backers = await backersOf(invoices.text);
  return backers.length;
};

/** Whether the invoices opinion rests on `person` now. */
const backs = async (person: string): Promise<boolean> => {
  const backers = await backersOf(invoices.text);
  return backers.includes(person);
};

/** The standing opinions' ids in the Brain (`brain_opinions.source`). */
const standingSources = async (): Promise<string[]> => {
  const rows = await rowsOf(
    "SELECT source FROM brain_opinions WHERE erase = 0"
  );
  return rows.map(({ source }) => String(source));
};

/**
 * Lets the onboarding give every team due to the Brain, as its alarm
 * would: none of these teams shares a line, so no model is asked.
 */
const intakesDone = async (): Promise<void> => {
  // Earlier tests of this file leave their teams due too.
  for (let round = 0; round < 200; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one team at a time
    if ((await onboardingStore(env).intakeNext()) === null) {
      return;
    }
  }
  throw new Error("Teams were still due after 200 intakes.");
};

/**
 * Runs the onboarding's alarm once, as its timer would, with `model`
 * answering, after every intake is done and the alarm cleared: how many
 * calls the model got, and how far out the alarm it leaves is set (null
 * for none).
 */
const alarmOnce = async (
  model: (requests: readonly SentRequest[]) => ProviderReply
) => {
  await intakesDone();
  await runInDurableObject(onboardingStore(env), async (_, state) => {
    await state.storage.deleteAlarm();
  });
  const { requests } = await answeringWith(model, async () => {
    await runInDurableObject(onboardingStore(env), async (instance) => {
      await Onboarding.prototype.alarm.call(instance);
    });
  });
  const at = await runInDurableObject(
    onboardingStore(env),
    async (_, state) => await state.storage.getAlarm()
  );
  return {
    asked: requests.length,
    armedIn: at === null ? null : at - Date.now(),
  };
};

/** How soon a run's next step is armed at most: well under any other wait the alarm keeps. */
const soon = 30_000;

/** An unrelated line only counted anonymously, which the faked model makes no view of. */
const aside = (id: string) =>
  anonymous(fact(id, "wish", "Would like a second screen at the desk."));

/** The invoice line, moved to how the person's team works. */
const sharedInvoice = () => ({
  ...said("v1", "invoice"),
  share: "team" as const,
});

/**
 * Three teams of three, everyone telling: five across the three teams
 * about invoices (two in Finance, two in Sales, one in Support), the four
 * others about the weekly meeting. Each person's id, by team.
 */
const threeTeamsTold = async (invoiceBackers = 5) => {
  const ids = await company([3, 3, 3]);
  const everyone = ids.flat();
  const [first = [], second = [], third = []] = ids;
  // Two of each of the first two teams, then the third's first, and its
  // second for a sixth.
  const order = [first[0], first[1], second[0], second[1], third[0], third[1]];
  const backers = new Set(order.slice(0, invoiceBackers));
  for (const person of everyone) {
    // oxlint-disable-next-line no-await-in-loop -- one interview at a time
    await agree(person, [
      said("v1", backers.has(person) ? "invoice" : "meeting"),
    ]);
  }
  return {
    ids,
    everyone,
    backers: [...backers].filter((id) => id !== undefined),
  };
};

describe(
  "the company's opinions from the interviews",
  { timeout: 120_000 },
  () => {
    beforeEach(holdAlarm);

    it("stand at five backers across three teams of three, for every member reading as themselves and on the Brain page, naming no team and counting nobody", async () => {
      const { everyone } = await threeTeamsTold();
      const reader = await accountOfPerson(everyone.at(-1) ?? "");
      // Nothing shows before the day's run: an approval alone puts nothing together.
      const before = await opinionsRecalled(reader, "invoices");
      const { ran } = await formOpinions(invoicesModel);
      await handOverNow();
      const recalled = await opinionsRecalled(reader, "invoices");
      const page = await onThePage();
      const read = [
        ...recalled,
        ...page.statements.map(({ text }) => text),
        page.source?.title ?? "",
      ].join("\n");
      expect({
        before,
        ran: ran.at(-1),
        recalled: recalled.map((text) => text.includes(invoices.text)),
        statements: page.statements.map(({ text, teamIds, kind }) => ({
          text,
          teamIds,
          kind,
        })),
        // The one source: no team, no count of anyone, no one's name.
        source:
          page.source === undefined
            ? null
            : {
                title: page.source.title,
                who: page.source.who,
                how: page.source.how,
                teamIds: page.source.teamIds,
              },
        teamNamed: teamNames.filter((name) => read.includes(name)),
        counted: /\d/u.test(read),
      }).toStrictEqual({
        before: [],
        ran: "opinions",
        recalled: [true],
        statements: [{ text: invoices.text, teamIds: [], kind: "timeSink" }],
        source: {
          title: "What people across the company say",
          who: undefined,
          how: undefined,
          teamIds: undefined,
        },
        teamNamed: [],
        counted: false,
      });
    });

    it("show nothing that four back, though nine told", async () => {
      const { everyone } = await threeTeamsTold(4);
      await formOpinions(invoicesModel);
      await handOverNow();
      expect({
        recalled: await opinionsRecalled(
          await accountOfPerson(everyone.at(-1) ?? ""),
          "invoices"
        ),
        page: await pageOpinions(),
      }).toStrictEqual({ recalled: [], page: [] });
    });

    it("show nothing, and ask no model, in a company where six told, though all six back it", async () => {
      const ids = await company([3, 3]);
      const everyone = ids.flat();
      for (const person of everyone) {
        // oxlint-disable-next-line no-await-in-loop -- one interview at a time
        await agree(person, [said("v1", "invoice")]);
      }
      const { requests } = await formOpinions(invoicesModel);
      await handOverNow();
      expect({
        asked: requests.length,
        recalled: await opinionsRecalled(
          await accountOfPerson(everyone[0] ?? ""),
          "invoices"
        ),
        page: await pageOpinions(),
      }).toStrictEqual({ asked: 0, recalled: [], page: [] });
    });

    it("follow the one floor: two more who told than five backers", () => {
      expect([6, 7].map(companyMayHaveOpinions)).toStrictEqual([false, true]);
    });

    it("are out of the Brain and the page as a backer's withdrawal commits, and hold the withdrawal back whole while the Brain can't take one out", async () => {
      const { everyone, backers } = await threeTeamsTold();
      const reader = await accountOfPerson(everyone.at(-1) ?? "");
      await formOpinions(invoicesModel);
      await handOverNow();
      const before = await opinionsRecalled(reader, "invoices");
      const device = await openLink(backers[0] ?? "");
      const undo = await restoring();
      const refused = await onLink({ action: "withdraw", ...device });
      const whileRestoring = {
        ok: refused.ok,
        read: await recalledCount(reader, "invoices"),
        page: await pageOpinions(),
      };
      await undo();
      const withdrawn = await onLink({ action: "withdraw", ...device });
      // Read the moment the withdrawal answers, before core's clock.
      expect({
        before: before.length,
        whileRestoring,
        withdrew: withdrawn.ok,
        after: await opinionsRecalled(reader, "invoices"),
        page: await pageOpinions(),
      }).toStrictEqual({
        before: 1,
        // Refused whole: nothing of the withdrawal is made. The opinion is
        // already marked, so it is off the page (fails closed), and back
        // at the next run while five still back it.
        whileRestoring: { ok: false, read: 1, page: [] },
        withdrew: true,
        after: [],
        page: [],
      });
    });

    it("stop resting on a line moved to the person's team: out as the save commits", async () => {
      const { everyone, backers } = await threeTeamsTold();
      const reader = await accountOfPerson(everyone.at(-1) ?? "");
      await formOpinions(invoicesModel);
      await handOverNow();
      const before = await opinionsRecalled(reader, "invoices");
      const mover = backers[0] ?? "";
      const { share: _anonymous, ...line } = said("v1", "invoice");
      const moved = [{ ...line, share: "team" as const }];
      const saved = await saveAgreed(mover, moved, 1);
      const atCommit = await opinionsRecalled(reader, "invoices");
      await approveAgreed(await openLink(mover), moved);
      expect({
        before: before.length,
        saved: saved.ok,
        atCommit,
        page: await pageOpinions(),
      }).toStrictEqual({ before: 1, saved: true, atCommit: [], page: [] });
    });

    it("give no model a team's or a person's name, and drop an opinion whose words name either", async () => {
      const ids = await company([3, 3, 3]);
      const everyone = ids.flat();
      for (const [index, person] of everyone.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one interview at a time
        await agree(person, [
          said(
            "v1",
            index < 5 ? "invoice" : "meeting",
            index < 5 ? " in Finance, ask Max Mol, the sales team or IT" : ""
          ),
        ]);
      }
      const named = "Finance types every invoice in again by hand.";
      const { requests } = await formOpinions(
        opinionsModel({
          views: [
            { when: "invoice", view: invoiceView },
            { when: "meeting", view: meetingView },
          ],
          opinions: [
            invoices,
            { kind: "timeSink", text: named, cites: [invoiceView] },
            {
              kind: "timeSink",
              text: "Someone like Max wants invoices typed for them.",
              cites: [invoiceView],
            },
          ],
        })
      );
      await handOverNow();
      const sent = requests
        .map((request) => JSON.stringify(request.body))
        .join(",");
      const names = [
        ...teamNames,
        ...peopleNames.flat().flatMap((name) => name.split(" ")),
      ];
      expect({
        asked: requests.length > 0,
        sent: names.filter((name) =>
          new RegExp(`\\b${name}\\b`, name.length < 4 ? "u" : "iu").test(sent)
        ),
        page: await pageOpinions(),
      }).toStrictEqual({ asked: true, sent: [], page: [invoices.text] });
    });

    it("are never in code's recall: an App's, a workflow's and a chat's code answer as if none stood, while a member finds it", async () => {
      const { everyone, backers } = await threeTeamsTold();
      const backer = await accountOfPerson(backers[0] ?? "");
      const reader = await accountOfPerson(everyone.at(-1) ?? "");
      const before = [await codeReads(backer), await codeReads(reader)];
      await formOpinions(invoicesModel);
      await handOverNow();
      const after = [await codeReads(backer), await codeReads(reader)];
      expect({
        member: await recalledCount(reader, "invoices"),
        code: after,
      }).toStrictEqual({ member: 1, code: before });
    });

    it("put nothing together until five people's lines changed since the last time: four ask no model and arm nothing, the fifth arms the run, and the opinion shows", async () => {
      const { everyone, backers } = await threeTeamsTold(4);
      await formOpinions(invoicesModel);
      const reader = await accountOfPerson(everyone.at(-1) ?? "");
      const meeting = everyone.filter((person) => !backers.includes(person));
      const tellsInvoices = async (person: string) =>
        await agree(person, [said("v1", "meeting"), said("v2", "invoice")], 1);
      for (const person of meeting.slice(0, 4)) {
        // oxlint-disable-next-line no-await-in-loop -- one interview at a time
        await tellsInvoices(person);
      }
      const four = await alarmOnce(invoicesModel);
      await tellsInvoices(meeting[4] ?? "");
      const five = await alarmOnce(invoicesModel);
      await formOpinions(invoicesModel);
      await handOverNow();
      expect({
        four: { asked: four.asked, armedSoon: (four.armedIn ?? soon) < soon },
        five: {
          asked: five.asked > 0,
          armedSoon: (five.armedIn ?? soon) < soon,
        },
        recalled: await recalledCount(reader, "invoices"),
        page: await pageOpinions(),
        backers: await backerCount(),
      }).toStrictEqual({
        four: { asked: 0, armedSoon: false },
        five: { asked: true, armedSoon: true },
        recalled: 1,
        page: [invoices.text],
        backers: 9,
      });
    });

    it("take in only what was agreed as a run began: a line added while it runs counts towards the next five, never that run", async () => {
      const { ids } = await threeTeamsTold();
      const store = onboardingStore(env);
      // Sales, a meeting person: their team is put together last (by id).
      const late = ids[1]?.[2] ?? "";
      const steps: string[] = [];
      await answeringWith(invoicesModel, async () => {
        for (let run = 0; run < 10; run += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one run at a time, as the alarm runs them
          const did = await store.opinionsNext();
          if (did === null) {
            return;
          }
          steps.push(did);
          if (steps.length === 1) {
            // oxlint-disable-next-line no-await-in-loop -- once, mid-run
            await agree(
              late,
              [said("v1", "meeting"), said("v2", "invoice")],
              1
            );
          }
          if (did === "opinions") {
            return;
          }
        }
      });
      const backers = await backersOf(invoices.text);
      expect({
        firstWasATeam: steps[0]?.startsWith("opinions:") ?? false,
        ended: steps.at(-1),
        late: backers.includes(late),
        backers: backers.length,
      }).toStrictEqual({
        firstWasATeam: true,
        ended: "opinions",
        late: false,
        backers: 5,
      });
    });

    const sixSay: {
      where: string;
      told: () => Promise<{ backers: string[] }>;
    }[] = [
      {
        where: "across three teams",
        told: async () => await threeTeamsTold(6),
      },
      {
        where: "in one team",
        told: async () => {
          const ids = await company([6, 3]);
          const everyone = ids.flat();
          for (const [index, person] of everyone.entries()) {
            // oxlint-disable-next-line no-await-in-loop -- one interview at a time
            await agree(person, [
              said("v1", index < 6 ? "invoice" : "meeting"),
            ]);
          }
          return { backers: everyone.slice(0, 6) };
        },
      },
    ];

    it.each(sixSay)(
      "rest on everyone who said it, $where: one of six withdrawing leaves it standing, with no row of theirs",
      async ({ told }) => {
        const { backers } = await told();
        await formOpinions(invoicesModel);
        await handOverNow();
        const leaving = backers[0] ?? "";
        const before = await backerCount();
        const withdrew = await onLink({
          action: "withdraw",
          ...(await openLink(leaving)),
        });
        const after = await backersOf(invoices.text);
        expect({
          before,
          withdrew: withdrew.ok,
          page: await pageOpinions(),
          after: after.length,
          theirs: await rowsNaming(leaving),
        }).toStrictEqual({
          before: 6,
          withdrew: true,
          page: [invoices.text],
          after: 5,
          theirs: { backers: [], candidates: [], people: [] },
        });
      }
    );

    it("drop an opinion that repeats a line as the model saw it, or holds a figure or a name fewer than five of its backers gave", async () => {
      const ids = await company([3, 3, 3]);
      const everyone = ids.flat();
      const distinctive =
        "In Finance we re-type all 340 invoices from Exact by hand every Monday.";
      for (const [index, person] of everyone.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one interview at a time
        await agree(person, [
          index === 0
            ? anonymous(fact("v1", "wish", distinctive))
            : said("v1", index < 5 ? "invoice" : "meeting"),
        ]);
      }
      await formOpinions(
        opinionsModel({
          views: [
            { when: "invoice", view: invoiceView },
            { when: "meeting", view: meetingView },
          ],
          opinions: [
            invoices,
            // The line as the model saw it, its team's name taken out.
            {
              kind: "timeSink",
              text: "In a team we re-type all 340 invoices from Exact by hand every Monday.",
              cites: [invoiceView],
            },
            // A near copy: a figure, a product and a day one person gave.
            {
              kind: "timeSink",
              text: "We re-type all 340 invoices from Exact by hand every Monday.",
              cites: [invoiceView],
            },
            // Someone's line word for word.
            {
              kind: "wish",
              text: "Re-typing every invoice by hand is a waste.",
              cites: [invoiceView],
            },
            // A candidate word for word.
            { kind: "timeSink", text: invoiceView, cites: [invoiceView] },
          ],
        })
      );
      await expect(pageOpinions()).resolves.toStrictEqual([invoices.text]);
    });

    it("leave no row of a backer who moves a line away while the merge's model is asked, though another line keeps them telling", async () => {
      const ids = await company([3, 3, 3]);
      const everyone = ids.flat();
      const racer = everyone[0] ?? "";
      for (const [index, person] of everyone.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one interview at a time
        await agree(
          person,
          index === 0
            ? [said("v1", "invoice"), said("v2", "meeting")]
            : [said("v1", index < 6 ? "invoice" : "meeting")]
        );
      }
      const store = onboardingStore(env);
      let moved: boolean | null = null;
      await answeringWith(
        async (requests) => {
          if (
            moved === null &&
            dataOf(requests.at(-1), "views") !== undefined
          ) {
            const kept = [sharedInvoice(), said("v2", "meeting")];
            const saved = await saveAgreed(racer, kept, 1);
            moved = saved.ok;
            await approveAgreed(await openLink(racer), kept);
          }
          return invoicesModel(requests);
        },
        async () => {
          for (let run = 0; run < 10; run += 1) {
            // oxlint-disable-next-line no-await-in-loop -- one run at a time
            const did = await store.opinionsNext();
            if (did === null || did === "opinions") {
              return;
            }
          }
        }
      );
      const backers = await backersOf(invoices.text);
      expect({
        moved,
        page: await pageOpinions(),
        racer: backers.includes(racer),
        backers: backers.length,
      }).toStrictEqual({
        moved: true,
        page: [invoices.text],
        racer: false,
        backers: 5,
      });
    });

    const erasures: {
      way: string;
      erase: (person: string) => Promise<void>;
    }[] = [
      {
        way: "their delete",
        erase: async (person) => {
          await onLink({ action: "delete", ...(await openLink(person)) });
        },
      },
      {
        way: "being taken off the staff list",
        erase: async (person) => {
          const { roster } = listed;
          if (roster === null) {
            throw new Error("No staff list was saved.");
          }
          await onboardingStore(env).saveRoster(
            {
              ...roster,
              people: roster.people.filter(({ id }) => id !== person),
            },
            by
          );
        },
      },
      {
        way: "core's erasure of their person",
        erase: async (person) => {
          const account = await accountOfPerson(person);
          const admin = await signedInApi(idp, "admin");
          await admin.api.members.remove(account);
          const name = await env.DB.prepare(
            "SELECT name FROM users WHERE id = ?"
          )
            .bind(account)
            .first<string>("name");
          await admin.api.members.erase(account, name ?? "");
          await ageOwnErasure(account);
          await retryErasures(env);
        },
      },
    ];

    it.each(erasures)(
      "hold nothing of someone after $way: no backer, candidate or line mark names them",
      async ({ erase }) => {
        const { backers } = await threeTeamsTold(6);
        await formOpinions(invoicesModel);
        const person = backers[0] ?? "";
        const before = await rowsNaming(person);
        await erase(person);
        expect({
          before: [before.backers, before.candidates, before.people].map(
            (rows) => rows.length > 0
          ),
          after: await rowsNaming(person),
        }).toStrictEqual({
          before: [true, true, true],
          after: { backers: [], candidates: [], people: [] },
        });
      }
    );

    const undone: {
      way: string;
      undo: (person: string) => Promise<void>;
    }[] = [
      {
        way: "a line moved to their team and back",
        undo: async (person) => {
          await agree(person, [sharedInvoice()], 1);
          await agree(person, [said("v1", "invoice")], 2);
        },
      },
      {
        way: "an edit undone",
        undo: async (person) => {
          await agree(person, [said("v1", "invoice", ", truly")], 1);
          await agree(person, [said("v1", "invoice")], 2);
        },
      },
      {
        way: "a new start with the same lines",
        undo: async (person) => {
          await onboardingStore(env).newStart(person, by);
          const device = await openLink(person);
          await openLinkAs(device.secret, device.cookie);
          const line = [said("v1", "invoice")];
          const saved = await saveAgreed(person, line, 2);
          if (!saved.ok) {
            throw new Error(
              `The save after a new start: ${await saved.text()}`
            );
          }
          await approveAgreed(device, line);
        },
      },
    ];

    it.each(undone)(
      "count someone again after $way, at the next run of five",
      async ({ undo }) => {
        const { ids, backers } = await threeTeamsTold();
        await formOpinions(invoicesModel);
        const person = backers[0] ?? "";
        await undo(person);
        const fallen = await pageOpinions();
        // Four people outside their team tell something unrelated too: with
        // them, five people's lines changed.
        const [, second = [], third = []] = ids;
        for (const other of [second[0], second[1], second[2], third[0]]) {
          const line = backers.includes(other ?? "")
            ? said("v1", "invoice")
            : said("v1", "meeting");
          // oxlint-disable-next-line no-await-in-loop -- one interview at a time
          await agree(other ?? "", [line, aside("v2")], 1);
        }
        await formOpinions(invoicesModel);
        expect({
          fallen,
          page: await pageOpinions(),
          backs: await backs(person),
        }).toStrictEqual({ fallen: [], page: [invoices.text], backs: true });
      }
    );

    it("ask no model again for a merge whose candidates didn't change, and keep its opinion's id, though the model would word it otherwise", async () => {
      const { everyone, backers } = await threeTeamsTold();
      await formOpinions(invoicesModel);
      const before = await standingSources();
      for (const person of everyone.slice(0, 5)) {
        const line = backers.includes(person)
          ? said("v1", "invoice")
          : said("v1", "meeting");
        // oxlint-disable-next-line no-await-in-loop -- one interview at a time
        await agree(person, [line, aside("v2")], 1);
      }
      const { requests, ran } = await formOpinions(
        opinionsModel({
          views: [
            { when: "invoice", view: invoiceView },
            { when: "meeting", view: meetingView },
          ],
          opinions: [
            {
              ...invoices,
              text: "Typing invoices in by hand again is slow and costs time.",
            },
          ],
        })
      );
      expect({
        ran: ran.at(-1),
        teamsAsked: requests.some(
          (request) => dataOf(request, "lines") !== undefined
        ),
        mergeAsked: requests.some(
          (request) => dataOf(request, "views") !== undefined
        ),
        sources: await standingSources(),
        page: await pageOpinions(),
      }).toStrictEqual({
        ran: "opinions",
        teamsAsked: true,
        mergeAsked: false,
        sources: before,
        page: [invoices.text],
      });
    });
  }
);
