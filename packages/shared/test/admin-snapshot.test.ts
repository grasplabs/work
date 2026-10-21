import { describe, expect, it } from "vite-plus/test";

import { adminSnapshotSchema } from "../src/admin-snapshot.ts";

const now = "2026-10-17T09:00:00.000Z";

/** A snapshot as a core of this release sends it, with `changes` made. */
const snapshot = (changes: Record<string, unknown> = {}) => ({
  now,
  company: {
    name: "Acme",
    timeZone: "Europe/Amsterdam",
    signInDomains: ["acme.test"],
    signIn: ["microsoft"],
    admins: [],
  },
  contacts: null,
  roster: {
    teams: [{ id: "sales", name: "Sales", lead: null, does: "", off: false }],
    people: [
      {
        id: "lea",
        name: "Lea Lund",
        email: "",
        team: "sales",
        title: "",
        away: false,
      },
    ],
  },
  plan: { start: "2026-10-16", days: 14 },
  agreements: { processing: true, assessment: true, council: "none" },
  agreed: true,
  paused: false,
  told: true,
  mapped: [],
  links: [],
  interviews: [],
  works: null,
  kickoff: null,
  gate: {
    open: false,
    closedSince: null,
    threshold: 70,
    known: 0,
    ready: false,
    over: false,
    openedAt: null,
  },
  contract: null,
  members: [],
  integrations: null,
  usage: [],
  ...changes,
});

describe("the admin snapshot as the console reads it", () => {
  it("reads a newer core's answer, dropping what it doesn't know", () => {
    const base = snapshot();
    const newer = snapshot({
      roster: {
        ...base.roster,
        teams: base.roster.teams.map((team) => ({ ...team, colour: "red" })),
        people: base.roster.people.map((one) => ({ ...one, pronouns: "she" })),
      },
      plan: { ...base.plan, rhythm: "weekly" },
      agreements: { ...base.agreements, insurance: true },
      contacts: { sponsor: "Ann" },
      works: [{ name: "Quotes" }],
      contract: { signed: true },
      integrations: {
        connected: [],
        personal: [],
        needed: [],
        requests: [],
        builds: [{ app: "acme_erp" }],
      },
      usage: [
        {
          day: "2026-10-16",
          use: {
            dreams: {
              "a-model": {
                calls: 1,
                tokensIn: 1,
                kept: 0,
                tokensOut: 1,
                seconds: 0,
              },
            },
          },
        },
      ],
      added: "a field this console doesn't know",
    });

    expect(adminSnapshotSchema.parse(newer)).toStrictEqual(
      adminSnapshotSchema.parse(
        snapshot({
          integrations: {
            connected: [],
            personal: [],
            needed: [],
            requests: [],
          },
          usage: [{ day: "2026-10-16", use: {} }],
        })
      )
    );
  });

  it("drops a purpose it doesn't know whatever that purpose's numbers look like", () => {
    const newer = snapshot({
      usage: [
        {
          day: "2026-10-16",
          use: { dreams: { "a-model": { minutes: 3 } }, wishes: 4 },
        },
      ],
    });

    expect(adminSnapshotSchema.parse(newer)).toStrictEqual(
      adminSnapshotSchema.parse(
        snapshot({ usage: [{ day: "2026-10-16", use: {} }] })
      )
    );
  });
});
