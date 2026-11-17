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
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import {
  accountOf,
  answeringWith,
  approveAgreed,
  holdAlarm,
  onLink,
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

/**
 * Three teams of three, everyone telling: five across the three teams
 * about invoices (two in Finance, two in Sales, one in Support), the four
 * others about the weekly meeting. Each person's id, by team.
 */
const threeTeamsTold = async (invoiceBackers = 5) => {
  const ids = await company([3, 3, 3]);
  const everyone = ids.flat();
  const [first = [], second = [], third = []] = ids;
  // Two of each of the first two teams, then the third's first.
  const order = [first[0], first[1], second[0], second[1], third[0]];
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
        // at the next day's run while five still back it.
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
  }
);
