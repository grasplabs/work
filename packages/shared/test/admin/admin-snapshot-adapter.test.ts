import { describe, expect, it } from "vite-plus/test";

import { adminSnapshotSchema } from "../../src/admin-snapshot.ts";
import { logItemsOf } from "../../src/admin/admin-log.ts";
import { missingOf } from "../../src/admin/admin-missing.ts";
import {
  adminOrgOf,
  staffSnapshotOf,
} from "../../src/admin/admin-snapshot-adapter.ts";
import { adminViewOf, portfolioOf } from "../../src/admin/admin-view.ts";
import { recordOf } from "../../src/admin/onboarding-admin-record.ts";
import { STARTING_ORG_RULES } from "../../src/admin/onboarding-admin.ts";
import { orgOfSnapshot } from "../../src/admin/org-adapter.ts";
import {
  answer,
  bothTalked,
  client,
  orders,
  snapshot,
} from "./fixtures/bakkerij.ts";

const metered = { calls: 0, tokensIn: 0, kept: 0, tokensOut: 0, seconds: 0 };

/** Everything the admin shows of the company on core's day. */
const shown = () => {
  const { org, state } = adminOrgOf(snapshot, client);
  return { org, view: adminViewOf(org, state, "2026-10-14") };
};

/** What needs Grasp at an organization read from core, on core's day, by kind. */
const kindsOf = (of: ReturnType<typeof adminOrgOf>) =>
  adminViewOf(of.org, of.state, "2026-10-14").needs.map((need) => need.kind);

/** Euros to a billionth, so sums worked out two ways compare equal. */
const euros = (spend: number | undefined): number =>
  Math.round((spend ?? 0) * 1e9) / 1e9;

/** A view as text, its maps and sets spelled out, to look for words in. */
const text = (value: unknown): string =>
  JSON.stringify(value, (_key: string, each: unknown): unknown => {
    if (each instanceof Map || each instanceof Set) {
      return [...each.entries()];
    }
    return each;
  });

describe("an organization from core's admin snapshot", () => {
  it("is told, nine days in, with the agreements in and its leads named", () => {
    const { view } = shown();

    expect(view.told).toBeTruthy();
    expect(view.day).toBe(9);
    expect(view.stages).toStrictEqual({
      conversation: "done",
      research: "later",
      agreed: "done",
      connected: "done",
      leads: "now",
      interviews: "now",
      open: "later",
    });
    expect(
      view.agreements.map(({ what, state, on }) => [what, state, on])
    ).toStrictEqual([
      ["processing", "signed", "2026-09-25"],
      ["assessment", "signed", "2026-09-29"],
      ["council", "none", null],
    ]);
  });

  it("shows where everyone stands, who is talking now, and who has no link yet", () => {
    const { view } = shown();
    const states = Object.fromEntries(
      view.people.map((each) => [each.person.id, each.state])
    );

    expect(states).toStrictEqual({
      lisa: "completed",
      tom: "progress",
      ann: "waiting",
      otto: "opened",
    });
    const tom = view.people.find((each) => each.person.id === "tom");
    expect(tom?.reminded).toBe(4);
    const sales = view.teams.find((team) => team.team.id === "sales");
    const ops = view.teams.find((team) => team.team.id === "ops");
    // Tom's link, the team's first, went out the day after Lisa was heard.
    expect([sales?.sent, sales?.heard]).toStrictEqual([1, 0]);
    expect([ops?.sent, ops?.heard]).toStrictEqual([null, null]);
  });

  it("counts who talked from core's numbers, and keeps a length only as core measured it", () => {
    const { view } = shown();
    const talked = Object.fromEntries(
      view.interviews.map((each) => [
        each.id,
        {
          kind: each.kind,
          approved: each.approved,
          stoppedAt: each.stoppedAt,
          minutes: each.minutes,
          facts: each.facts,
          out: each.out,
          typed: each.typed,
          rating: each.rating,
        },
      ])
    );

    // Core counts the facts kept apart from those taken out; the admin, every one written.
    expect(talked).toStrictEqual({
      lisa: {
        kind: "lead",
        approved: true,
        stoppedAt: null,
        minutes: 40,
        facts: 14,
        out: 2,
        typed: false,
        rating: 5,
      },
      tom: {
        kind: "employee",
        approved: false,
        stoppedAt: "steps",
        minutes: 15,
        facts: 3,
        out: 0,
        typed: true,
        rating: null,
      },
    });
  });

  it("keeps an interview the kind it was held as, when the team's lead changed since", () => {
    // Lisa talked as Sales's lead; the roster now names Tom.
    const changed = adminOrgOf(
      {
        ...snapshot,
        roster: snapshot.roster && {
          ...snapshot.roster,
          teams: snapshot.roster.teams.map((team) =>
            team.id === "sales" ? { ...team, lead: "tom" } : team
          ),
        },
      },
      client
    );
    const view = adminViewOf(changed.org, changed.state, "2026-10-14");

    expect(
      Object.fromEntries(view.interviews.map((each) => [each.id, each.kind]))
    ).toStrictEqual({ lisa: "lead", tom: "employee" });
  });

  it("knows what core knows, against core's threshold, and stays closed without Grasp's go", () => {
    const { view } = shown();

    const { percent, threshold, ready, opened } = view.knowledge;
    expect({
      percent,
      threshold,
      ready,
      opened,
      open: view.open,
    }).toStrictEqual({
      percent: 62,
      threshold: 80,
      ready: false,
      opened: null,
      open: false,
    });
    expect(view.needs.map((need) => need.kind)).not.toContain("go");
    // Core sends its number without its parts: no breakdown that wouldn't add up to it.
    expect(view.knowledge.sources).toStrictEqual([]);
  });

  it("waits for the works council, and keeps an interview deleted as its person asked", () => {
    const waiting = adminOrgOf(
      {
        ...snapshot,
        agreements: {
          processing: true,
          assessment: true,
          council: "waiting",
        },
        // Core forgets a deleted interview at once, and keeps when it went.
        links: snapshot.links.map((link) =>
          link.person === "lisa"
            ? {
                ...link,
                deletedAt: "2026-10-07T12:00:00.000Z",
                state: "opened" as const,
              }
            : link
        ),
        interviews: snapshot.interviews.filter(
          (interview) => interview.person !== "lisa"
        ),
      },
      client
    );
    const view = adminViewOf(waiting.org, waiting.state, "2026-10-14");

    expect({
      council: view.agreements.find((each) => each.what === "council")?.state,
      stage: view.stages.agreed,
      need: view.needs.some(
        (need) => need.kind === "agreement" && need.what === "council"
      ),
      deleted: view.people.find((each) => each.person.id === "lisa")?.deleted,
    }).toStrictEqual({
      council: "waiting",
      stage: "waits",
      need: true,
      deleted: true,
    });
  });

  it("counts a fresh interview someone saved after deleting theirs", () => {
    // Lisa deleted hers on day 2, opened her link again and agreed to a new one on day 3.
    const again = adminOrgOf(
      {
        ...snapshot,
        links: snapshot.links.map((link) =>
          link.person === "lisa"
            ? { ...link, deletedAt: "2026-10-07T12:00:00.000Z" }
            : link
        ),
        interviews: snapshot.interviews.map((interview) =>
          interview.person === "lisa"
            ? {
                ...interview,
                startedAt: "2026-10-08T08:00:00.000Z",
                completedAt: "2026-10-08T08:30:00.000Z",
                updatedAt: "2026-10-08T08:30:00.000Z",
              }
            : interview
        ),
      },
      client
    );
    const view = adminViewOf(again.org, again.state, "2026-10-14");
    const lisa = view.people.find((each) => each.person.id === "lisa");

    expect({
      deleted: lisa?.deleted,
      state: lisa?.state,
      talked: view.interviews.some((each) => each.id === "lisa"),
      completed: view.counts.completed,
    }).toStrictEqual({
      deleted: false,
      state: "completed",
      talked: true,
      completed: 1,
    });
  });

  it("is open from the day of Grasp's go, and wants the go once enough is known", () => {
    const opened = adminOrgOf(
      {
        ...snapshot,
        gate: {
          ...snapshot.gate,
          open: true,
          closedSince: null,
          openedAt: "2026-10-12T15:00:00.000Z",
        },
      },
      client
    );
    const ready = adminOrgOf(
      { ...snapshot, gate: { ...snapshot.gate, known: 85, ready: true } },
      client
    );

    const view = adminViewOf(opened.org, opened.state, "2026-10-14");
    expect([view.knowledge.opened, view.open, view.stages.open]).toStrictEqual([
      7,
      true,
      "done",
    ]);
    expect(
      adminViewOf(ready.org, ready.state, "2026-10-14").needs[0]
    ).toStrictEqual({ kind: "go", percent: 85, threshold: 80 });
  });

  it("shows interviews Grasp paused first, as nobody gets on until it resumes them", () => {
    const paused = adminOrgOf(
      {
        ...snapshot,
        paused: true,
        gate: { ...snapshot.gate, known: 85, ready: true },
      },
      client
    );
    const unpaused = adminOrgOf(snapshot, client);
    const untold = adminOrgOf(
      { ...snapshot, paused: true, told: false },
      client
    );

    expect(paused.org.real?.paused).toBeTruthy();
    expect(kindsOf(paused).slice(0, 2)).toStrictEqual(["paused", "go"]);
    expect(kindsOf(unpaused)).not.toContain("paused");
    expect(kindsOf(untold)).not.toContain("paused");
  });

  it("runs the interviews as long as core's plan, past the samples' fourteen days", () => {
    // Six weeks planned; day 27 now. Tom finished on day 23 and Grasp's go came on day 20.
    const long = adminOrgOf(
      {
        ...snapshot,
        now: "2026-11-01T10:00:00Z",
        plan: { ...snapshot.plan, start: "2026-10-05", days: 42 },
        gate: {
          ...snapshot.gate,
          open: true,
          closedSince: null,
          openedAt: "2026-10-25T15:00:00.000Z",
        },
        links: snapshot.links.map((link) =>
          link.person === "tom" ? { ...link, state: "completed" } : link
        ),
        interviews: snapshot.interviews.map((interview) =>
          interview.person === "tom"
            ? {
                ...interview,
                completedAt: "2026-10-28T10:00:00.000Z",
                updatedAt: "2026-10-28T10:00:00.000Z",
                agreed: true,
                phase: "readback" as const,
                stoppedAt: null,
              }
            : interview
        ),
      },
      client
    );
    const view = adminViewOf(long.org, long.state, "2026-11-01");

    expect({
      day: view.day,
      closed: view.closed,
      opened: view.knowledge.opened,
      talked: view.interviews.map((each) => each.id).toSorted(),
      tom: view.people.find((each) => each.person.id === "tom")?.state,
    }).toStrictEqual({
      day: 27,
      closed: false,
      opened: 20,
      talked: ["lisa", "tom"],
      tom: "completed",
    });
  });

  it("counts the AI core counted, by day and by what it was for", () => {
    const { view } = shown();

    const { counted, days, purposes, total } = view.usage;
    expect({
      counted,
      days: days.map((each) => each.day),
      interviews: [purposes.interviews.tokensIn, purposes.interviews.spoken],
      drawing: purposes.drawing.tokensOut,
    }).toStrictEqual({
      counted: true,
      days: ["2026-10-05", "2026-10-14"],
      // Tokens read, new and kept together; minutes of Stephen's voice.
      interviews: [1_150_000, 20],
      drawing: 5000,
    });
    expect(total.spend).toBeGreaterThan(0);
  });

  it("works out the interviews before core first counted, and takes core's count from that day on", () => {
    // Core counted only from Tom's day: Lisa's interview, before it, is
    // worked out from its 40 minutes; Tom's, on it, is what core counted.
    const late = adminOrgOf(
      { ...snapshot, usage: snapshot.usage.slice(1) },
      client
    );
    const { days } = adminViewOf(late.org, late.state, "2026-10-14").usage;
    const [lisa, tom] = days;

    expect({
      day: lisa?.day,
      sonnet: euros(lisa?.models.sonnet),
      opus: euros(lisa?.models.opus),
      voice: euros(lisa?.models.voice),
      ears: euros(lisa?.models.ears),
    }).toStrictEqual({
      day: "2026-10-05",
      // 40 minutes: both models read 8000 tokens a minute; the quick one
      // writes 120, the careful one 200 and then draws her team's map.
      sonnet: euros((40 * 8000 * 3 + 40 * 120 * 15) / 1e6),
      opus: euros((40 * 8000 * 5 + 40 * 200 * 25 + 5000 * 5 + 1400 * 25) / 1e6),
      // He speaks a fifth of the time and listens to the rest.
      voice: euros(40 * 0.2 * 0.15),
      ears: euros(40 * 0.8 * 0.006),
    });
    // Tom's day is core's count alone: nothing worked out on top of it.
    expect(tom).toStrictEqual(shown().view.usage.days[1]);
    expect(days).toHaveLength(2);
  });

  it("counts no chat nobody had, once the company is in", () => {
    const opened = adminOrgOf(
      {
        ...snapshot,
        gate: {
          ...snapshot.gate,
          open: true,
          closedSince: null,
          openedAt: "2026-10-12T15:00:00.000Z",
        },
      },
      client
    );

    const { members, usage } = adminViewOf(
      opened.org,
      opened.state,
      "2026-10-14"
    );
    // Its members are in, and core counted none of their chat.
    expect({
      active: members.filter((member) => member.state === "active").length,
      chat: [usage.purposes.chat.tokensIn, usage.purposes.runs.tokensIn],
    }).toStrictEqual({ active: 2, chat: [0, 0] });
  });

  it("counts the AI of a model it has no price for, with its spend unknown", () => {
    // An organization's own OpenAI-compatible endpoint has no list price.
    const unpriced = adminOrgOf(
      {
        ...snapshot,
        usage: [
          {
            day: "2026-10-05",
            use: {
              reading: {
                "openai-compatible/llama-3.3-70b": {
                  ...metered,
                  calls: 2,
                  tokensIn: 9000,
                  tokensOut: 1500,
                },
              },
            },
          },
        ],
      },
      client
    );
    const { usage } = adminViewOf(unpriced.org, unpriced.state, "2026-10-14");

    expect({
      counted: usage.counted,
      other: usage.models.other,
      reading: usage.purposes.reading.tokensIn,
    }).toStrictEqual({
      counted: true,
      other: { tokensIn: 9000, tokensOut: 1500, spoken: 0, heard: 0, spend: 0 },
      reading: 9000,
    });
  });

  it("keeps in its log who was told and who talked, by the day, with no Worker activity", () => {
    const { view } = shown();
    const kinds = new Set(
      logItemsOf(view, []).flatMap((item) =>
        item.source.from === "company" ? [item.source.event.kind] : []
      )
    );

    expect([
      kinds.has("told"),
      kinds.has("lead"),
      kinds.has("talked"),
    ]).toStrictEqual([true, true, true]);
  });

  it("names its members as core does, ready for when it opens", () => {
    const { view } = shown();

    expect(
      view.members.map(({ id, name, role, state, joined }) => ({
        id,
        name,
        role,
        state,
        joined,
      }))
    ).toStrictEqual([
      {
        id: "u-eva",
        name: "Eva Mulder",
        role: "admin",
        state: "ready",
        joined: "2026-09-22",
      },
      {
        id: "u-bram",
        name: "Bram Visser",
        role: "builder",
        state: "ready",
        joined: "2026-09-23",
      },
    ]);
  });

  it("reads a contract core doesn't hold as unknown, not as a draft or as none, and its work as core sends it", () => {
    const { view } = shown();
    const { org, state } = adminOrgOf(snapshot, client);
    const real = {
      ...org.real,
      unknown: { contract: false, works: false },
    };
    const knownView = adminViewOf({ ...org, real }, state, "2026-10-14");

    expect({
      unknown: view.unknown,
      contractNeed: view.needs.some((need) => need.kind === "contract"),
      counted: portfolioOf([view]).counted,
    }).toStrictEqual({
      unknown: { contract: true, works: false },
      contractNeed: false,
      // Its hours are counted from the work core sends; its fees not yet.
      counted: { fees: 0, value: 1 },
    });
    // Once core holds them, the draft contract waits for Grasp as before.
    expect({
      unknown: knownView.unknown,
      contractNeed: knownView.needs.some((need) => need.kind === "contract"),
    }).toStrictEqual({
      unknown: { contract: false, works: false },
      contractNeed: true,
    });
  });

  it("counts a team's links from when its colleagues' went out, and asks no one to read words core never sends", () => {
    const { view } = shown();
    const sales = view.teams.find((team) => team.team.id === "sales");

    expect({
      // Lisa finished on the first day; Tom's link went out the day after.
      salesSent: sales?.sent,
      read: view.needs.some((need) => need.kind === "read"),
    }).toStrictEqual({ salesSent: 1, read: false });
  });

  it("leaves unknown what core doesn't hold", () => {
    const { org, view } = shown();

    // No contract: nothing signed, no fee, no seats, no invoices.
    expect({
      status: view.contract.status,
      fee: view.contract.fee,
      seats: view.contract.seats,
      invoices: view.invoices,
    }).toStrictEqual({ status: "draft", fee: 0, seats: 0, invoices: [] });
    expect({
      contacts: view.contacts,
      integrations: view.integrations,
      // No work drawn: no hours claimed for any.
      works: view.works,
      hours: [view.value.hours, view.value.counted],
      languages: org.stephen.languages,
      transcripts: org.real?.transcripts.size,
    }).toStrictEqual({
      contacts: {},
      integrations: [],
      works: [],
      hours: [0, 0],
      languages: [],
      transcripts: 0,
    });
  });

  it("takes no words from core beyond the names of its company, teams and people", () => {
    const staff = staffSnapshotOf(snapshot, client);
    const { view } = shown();

    // Nothing anyone said, and no link: a link is a credential.
    expect({
      said: staff.interviews.map(({ progress }) => [
        progress.lines,
        progress.facts,
      ]),
      links: staff.links.map((each) => each.secret + each.code),
      client: staff.clientCode,
    }).toStrictEqual({
      said: [
        [[], []],
        [[], []],
      ],
      links: ["", "", "", ""],
      client: "",
    });
    // The only words in the admin's view, beyond its own codes, ids and times, are names and what a team does.
    const words = new Set(
      Array.from(
        text(view).matchAll(/"(?<word>[A-Z][^"]*|[^"]* [^"]*)"/gu),
        (match) => match.groups?.word
      )
    );
    expect(words).toStrictEqual(
      new Set([
        "Ann Bos",
        "Bakes",
        "Bakkerij Noord",
        "Bram Visser",
        "Eva Mulder",
        "Ann",
        "Lisa",
        "Otto",
        "Tom",
        "Lisa de Vries",
        "Operations",
        "Otto Smit",
        "Sales",
        "Sells bread to shops",
        "Tom Jansen",
      ])
    );
  });

  it("counts no days before the first link went out, whatever core planned", () => {
    const planned = adminOrgOf(
      {
        ...snapshot,
        told: false,
        links: snapshot.links.map((link) => ({
          ...link,
          sentAt: null,
          openedAt: null,
          remindedAt: null,
          state: "waiting" as const,
        })),
        interviews: [],
      },
      client
    );
    const view = adminViewOf(planned.org, planned.state, "2026-10-14");

    expect(view.told).toBeFalsy();
    expect(view.day).toBe(0);
    expect(view.stages.connected).toBe("done");
    expect(view.people.map((each) => each.state)).toStrictEqual([
      "waiting",
      "waiting",
      "waiting",
      "waiting",
    ]);
  });

  it("reads an answer from a newer core the same, and keeps out what it added", () => {
    const newer = adminSnapshotSchema.parse({
      ...answer,
      company: { ...answer.company, logo: "https://bakkerij.test/logo.png" },
      links: answer.links.map((link) => ({
        ...link,
        code: `bakkerij.${link.person}-secret`,
      })),
      interviews: answer.interviews.map((interview) => ({
        ...interview,
        summary: "The orders come in by phone and get lost",
      })),
      contract: { plan: "Grasp", fee: 4000 },
      gate: { ...answer.gate, parts: [{ source: "kickoff", known: 0.6 }] },
      usage: answer.usage.map((day) => ({
        ...day,
        use: {
          ...day.use,
          chat: { "claude-haiku-4-5": { ...metered, calls: 1 } },
        },
      })),
    });

    const adapted = staffSnapshotOf(newer, client);
    expect(adapted).toStrictEqual(staffSnapshotOf(snapshot, client));
    expect(text(orgOfSnapshot(adapted))).not.toMatch(
      /secret|lost|Taking orders|"fee":4000|"plan":"Grasp"|logo/u
    );
  });

  it("shows staff a drawn piece of work with each person's numbers apart, its open questions, under the organization's rules", () => {
    const rules = { ...STARTING_ORG_RULES, people: 2 };
    const { org, state } = adminOrgOf(
      { ...bothTalked, works: { works: [orders], rules, counted: ["orders"] } },
      client
    );
    const view = adminViewOf(org, state, "2026-10-14");
    const record = recordOf(view, "orders");
    const missing = record
      ? missingOf(record, orders.drawn?.open).map(({ kind }) => kind)
      : [];

    expect({
      unknown: view.unknown.works,
      rules: state.rules,
      evidence: view.works.map(({ id, approved, state: stands, byHand }) => [
        id,
        approved,
        stands,
        byHand,
      ]),
      volume: record?.volume,
      wrong: record?.wrong,
      heardFrom: record?.interviews.map(({ person }) => person.id),
      missing,
    }).toStrictEqual({
      unknown: false,
      rules,
      // Two of three talked: not known by the rules, but counted by hand.
      evidence: [["orders", 2, "complete", true]],
      // The lowest and the highest anyone said, never an average.
      volume: { quiet: [20, 60], busy: [40, 80], people: 2 },
      wrong: { outOfTen: [2, 2], people: 1 },
      heardFrom: ["lisa", "tom"],
      missing: ["people", "around", "around", "question"],
    });
  });
});
