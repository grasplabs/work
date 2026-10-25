import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { STARTING_ORG_RULES } from "@grasp-os/shared/admin/onboarding-admin";
import { recordOf } from "@grasp-os/shared/admin/onboarding-admin-record";
import type { Told } from "@grasp-os/shared/admin/org-record";
import type { StaffWorks } from "@grasp-os/shared/onboarding-staff";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Around, Numbers, StepEvidence } from "./work-record.tsx";
import { workViewOf } from "./work-words.ts";

// A piece of work as Grasp's staff read it (GRA-1087: open, and audited):
// each person's own numbers beside them, those they gave for one step or
// one case too, from what it renders.

const isoAt = (day: string, time = "09:00:00.000Z"): string => `${day}T${time}`;

/** Sales: Lisa, Tom and Ann all talked about taking orders. */
const people = ["lisa", "tom", "ann"] as const;
const names = { lisa: "Lisa de Vries", tom: "Tom Jansen", ann: "Ann Bos" };

const snapshot: AdminSnapshot = {
  now: isoAt("2026-10-14", "10:05:00.000Z"),
  company: {
    name: "Bakkerij Noord",
    timeZone: "Europe/Amsterdam",
    signInDomains: ["bakkerij.test"],
    signIn: ["microsoft"],
    admins: [],
  },
  contacts: null,
  roster: {
    teams: [{ id: "sales", name: "Sales", lead: "lisa", does: "", off: false }],
    people: people.map((id) => ({
      id,
      name: names[id],
      team: "sales",
      email: "",
      title: "",
      away: false,
    })),
  },
  plan: { start: "2026-10-05", days: 14 },
  agreements: { processing: true, assessment: true, council: "none" },
  agreed: true,
  paused: false,
  told: true,
  mapped: ["sales"],
  links: people.map((person) => ({
    person,
    state: "completed" as const,
    sentAt: isoAt("2026-10-05"),
    openedAt: isoAt("2026-10-06"),
    remindedAt: null,
    deletedAt: null,
  })),
  interviews: people.map((person) => ({
    person,
    kind: person === "lisa" ? ("lead" as const) : ("own" as const),
    startedAt: isoAt("2026-10-07"),
    completedAt: isoAt("2026-10-07", "09:30:00.000Z"),
    updatedAt: isoAt("2026-10-07", "09:30:00.000Z"),
    agreed: true,
    phase: "readback" as const,
    stoppedAt: null,
    minutes: 30,
    facts: 8,
    out: 0,
    confirmed: 8,
    rating: 5,
    typed: true,
    interviewer: "stephen" as const,
  })),
  works: null,
  kickoff: null,
  gate: {
    open: false,
    closedSince: null,
    threshold: 80,
    known: 40,
    ready: false,
    over: false,
    openedAt: null,
  },
  contract: null,
  members: [],
  integrations: null,
  asked: [],
  usage: [],
};

const told = (numbers: Partial<Told>): Told => ({
  start: true,
  steps: [0, 1],
  end: true,
  way: null,
  waits: [],
  differently: [],
  decides: false,
  own: false,
  ai: false,
  volume: null,
  takes: null,
  wrong: null,
  right: false,
  ask: false,
  next: false,
  example: null,
  term: false,
  out: [],
  ...numbers,
});

/** Lisa gave the whole's numbers and a step's minutes; Tom only a case's share; Ann only a step's minutes. */
const works: StaffWorks = {
  works: [
    {
      id: "orders",
      team: "sales",
      name: "Taking orders",
      item: ["order", "orders"],
      doers: [...people],
      share: 0.6,
      from: "lead",
      stale: false,
      drawn: {
        at: isoAt("2026-10-07", "10:00:00.000Z"),
        from: [...people],
        starts: "A shop calls with an order.",
        steps: [
          {
            text: "Write the order down in the order sheet.",
            who: "Sales",
            tool: "Excel",
            minutes: [2, 5, 10],
            documented: false,
          },
          {
            text: "Send the order to the bakery.",
            who: "Sales",
            tool: "Email",
            minutes: null,
            documented: false,
          },
        ],
        waits: [],
        differently: [
          {
            when: "the shop is new",
            does: "Ask Finance for a customer number.",
            outOfTen: 1,
            after: 0,
          },
        ],
        decides: "",
        own: "",
        ai: "",
        right: "",
        ask: "",
        next: "",
        term: null,
        differs: null,
        per: "week",
        unit: "minutes",
        told: {
          lisa: told({
            volume: [20, 40],
            volumeOf: "me",
            takes: [2, 5, 10],
            stepMinutes: [{ step: 0, minutes: [2, 4, 9] }],
          }),
          tom: told({ caseShares: [{ case: 0, outOfTen: 2 }] }),
          ann: told({ stepMinutes: [{ step: 0, minutes: [3, 6, 12] }] }),
        },
        open: [],
      },
    },
  ],
  rules: STARTING_ORG_RULES,
  counted: [],
};

const view = workViewOf({ snapshot, works });
const record = recordOf(view, "orders");
const drawn = works.works[0]?.drawn ?? null;

/** What `node` renders, as text without its markup. */
const textOf = (node: ReactNode): string =>
  renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>)
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ");

describe("a piece of work as staff read it", () => {
  it("shows each person's own minutes for a step and share of a case beside them, and lists whoever gave only those", () => {
    if (record === null) {
      throw new Error("The work has a record");
    }
    const step = textOf(
      <StepEvidence drawn={drawn} index={0} record={record} />
    );
    const cases = textOf(<Around drawn={drawn} record={record} />);
    const numbers = textOf(<Numbers drawn={drawn} record={record} />);

    expect({
      lisaStep: step.includes(
        "Lisa de Vries Told it Their own: 4 minutes, 2 to 9"
      ),
      annStep: step.includes("Ann Bos Told it Their own: 6 minutes, 3 to 12"),
      tomCase: cases.includes("Tom Jansen: 2 in 10"),
      // Tom and Ann gave no number of the whole, and are listed all the same.
      listed: (["Lisa de Vries", "Tom Jansen", "Ann Bos"] as const).map(
        (name) => numbers.includes(name)
      ),
    }).toStrictEqual({
      lisaStep: true,
      annStep: true,
      tomCase: true,
      listed: [true, true, true],
    });
  });
});
