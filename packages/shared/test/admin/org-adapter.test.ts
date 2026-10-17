import { describe, expect, it } from "vite-plus/test";

import { organizationOf } from "../../src/admin/admin-organization.ts";
import { PRICES } from "../../src/admin/admin-usage.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import { meteredOf, orgOfSnapshot } from "../../src/admin/org-adapter.ts";
import { NEW_CLIENT, NOTHING_SAID } from "../../src/admin/org-record.ts";
import type {
  DrawnWork,
  HeldInterview,
  StaffSnapshot,
} from "../../src/admin/org-record.ts";

const person = (
  id: string,
  name: string,
  team: string,
  work: string | null = null
) => ({
  id,
  name,
  email: `${id}@rivierdal.test`,
  team,
  title: "Medewerker",
  away: false,
  work,
});
const link = (
  id: string,
  state: StaffSnapshot["links"][number]["state"],
  sent: string | null = "2026-10-05T07:00:00Z"
) => ({
  person: id,
  secret: "s",
  code: `rivierdal.${id}`,
  sent,
  opened: sent,
  reminded: null,
  state,
});
const held = (
  id: string,
  kind: HeldInterview["kind"],
  completed: string | null,
  rating?: number
): HeldInterview => ({
  person: id,
  kind,
  progress: {
    ...NOTHING_SAID,
    person: completed === null ? "incomplete" : "completed",
    mode: "type",
    startedAt: Date.parse("2026-10-05T09:00:00Z"),
    phase: "story",
    ...(rating === undefined ? {} : { rating }),
  },
  version: 3,
  updated: completed ?? "2026-10-05T09:10:00Z",
  completed,
  stopped: null,
});
const drawn: DrawnWork = {
  at: "2026-10-05T10:00:00Z",
  from: ["lisa"],
  starts: "A customer writes.",
  steps: [
    {
      text: "Open the ticket.",
      who: "Agent",
      tool: "Zendesk",
      minutes: null,
      documented: false,
    },
    {
      text: "Look the customer up.",
      who: "Agent",
      tool: "Excel",
      minutes: null,
      documented: false,
    },
    {
      text: "Answer the customer.",
      who: "Agent",
      tool: "Zendesk",
      minutes: null,
      documented: false,
    },
  ],
  waits: [],
  differently: [],
  decides: "",
  own: "",
  ai: "",
  right: "",
  ask: "",
  next: "Hypotheekadvies takes over a claim.",
  term: null,
  differs: null,
  per: "week",
  unit: "minutes",
  told: {
    lisa: {
      start: true,
      steps: [0, 1, 2],
      end: true,
      way: null,
      waits: [],
      differently: [],
      decides: false,
      own: false,
      ai: false,
      volume: [20, 30],
      takes: [5, 8, 15],
      wrong: 1,
      right: false,
      ask: false,
      next: true,
      example: null,
      term: false,
      out: [],
    },
  },
  open: [],
};
const snapshot: StaffSnapshot = {
  profile: {
    id: "rivierdal",
    name: "Rivierdal",
    about: "advice",
    website: "rivierdal.test",
    place: "Arnhem",
    language: "nl",
    sponsor: { name: "Eva", title: "CEO", email: "" },
    admin: { name: "Ad", title: "", email: "" },
    created: "2026-10-01T08:00:00Z",
    test: true,
  },
  clientCode: "rivierdal.client",
  client: { ...NEW_CLIENT, directory: "list", reached: 7 },
  roster: {
    teams: [
      {
        id: "t-service",
        name: "Klantenservice",
        lead: "daan",
        does: "Answers customers",
        off: false,
      },
      {
        id: "t-mortgage",
        name: "Hypotheekadvies",
        lead: "mark",
        does: "Mortgages",
        off: false,
      },
      { id: "t-board", name: "Directie", lead: null, does: "", off: true },
    ],
    people: [
      person("daan", "Daan Bakker", "t-service"),
      person("lisa", "Lisa Jansen", "t-service", "w-tickets"),
      person("tim", "Tim de Groot", "t-service", "w-tickets"),
      person("mark", "Mark de Vries", "t-mortgage"),
      person("eva", "Eva Bos", "t-board"),
    ],
  },
  plan: { start: "2026-10-05", days: 14, told: "2026-10-02T10:00:00Z" },
  grasp: {},
  links: [
    link("daan", "completed"),
    link("lisa", "completed"),
    link("tim", "invited"),
    link("mark", "invited"),
  ],
  interviews: [
    held("daan", "lead", "2026-10-05T09:30:00Z"),
    held("lisa", "employee", "2026-10-05T11:00:00Z", 4),
  ],
  works: [
    {
      id: "w-tickets",
      team: "t-service",
      name: "handling new tickets",
      local: "nieuwe tickets afhandelen",
      item: ["ticket", "tickets"],
      doers: ["lisa", "tim"],
      share: 0.8,
      from: "lead",
      drawn,
      stale: false,
    },
  ],
  mapped: ["t-service"],
  events: [],
  usage: [
    {
      day: "2026-10-05",
      use: {
        interviews: {
          "claude-sonnet-5-5": {
            calls: 10,
            tokensIn: 100_000,
            kept: 400_000,
            tokensOut: 2000,
            seconds: 0,
          },
          voice: { calls: 4, tokensIn: 0, kept: 0, tokensOut: 0, seconds: 120 },
          "something-else": {
            calls: 1,
            tokensIn: 5,
            kept: 0,
            tokensOut: 5,
            seconds: 0,
          },
        },
        drawing: {
          "claude-opus-5-5": {
            calls: 1,
            tokensIn: 6000,
            kept: 0,
            tokensOut: 1500,
            seconds: 0,
          },
        },
      },
    },
  ],
  now: "2026-10-06T12:00:00Z",
};

describe("a real organization as the admin reads it", () => {
  const org = orgOfSnapshot(snapshot);
  const view = adminViewOf(org, org.seed, "2026-10-06");

  it("carries which teams take part, and counts nobody in a team that does not", () => {
    expect(org.seed.left).toStrictEqual(["t-board"]);
    expect(view.teams.map((team) => [team.team.id, team.off])).toStrictEqual([
      ["t-service", false],
      ["t-mortgage", false],
      ["t-board", true],
    ]);
    expect(view.people.find((each) => each.person.id === "eva")).toMatchObject({
      state: "away",
      out: true,
    });
    // Four are asked: the director's team is left out. The leads stage waits for Mark only.
    expect([view.asked, view.stages.leads]).toStrictEqual([4, "now"]);
    expect(organizationOf(view)).toMatchObject({
      taking: 2,
      leadsNamed: 2,
      leadsTalked: 1,
      people: 5,
      asked: 4,
      talked: 2,
    });
  });

  it("names the work as a title, with who does it, the apps it is done in and the team it goes to", () => {
    const chart = organizationOf(view);
    const service = chart.teams.find(
      (team) => team.view.team.id === "t-service"
    );
    expect(service?.works.map((work) => work.evidence.work.name)).toStrictEqual(
      ["Handling new tickets"]
    );
    expect(
      service?.works[0]?.doers.map((each) => each.person.id)
    ).toStrictEqual(["lisa", "tim"]);
    expect(service?.tools).toStrictEqual([
      { name: "Excel", works: 1 },
      { name: "Zendesk", works: 1 },
    ]);
    expect(service?.to.map((each) => each.to)).toStrictEqual(["t-mortgage"]);
    expect(
      chart.teams.find((team) => team.view.team.id === "t-mortgage")?.from
    ).toHaveLength(1);
  });

  it("asks Grasp for the first conversation until Stephen has read it, without holding up its steps", () => {
    expect(view.stage).toBe("leads");
    expect(view.needs).toContainEqual({ kind: "transcript" });
    expect(
      adminViewOf(org, { ...org.seed, conversation: "in" }, "2026-10-06").needs
    ).toContainEqual({ kind: "transcript" });
    const read = adminViewOf(
      org,
      { ...org.seed, conversation: "read" },
      "2026-10-06"
    );
    expect(read.needs).not.toContainEqual({ kind: "transcript" });
    expect(read.stage).toBe("leads");
  });

  it("carries what someone said of their interview", () => {
    expect(view.interviews.find((each) => each.id === "lisa")?.rating).toBe(4);
    expect(
      view.interviews.find((each) => each.id === "daan")?.rating
    ).toBeNull();
  });

  it("counts AI use as the Worker counted it, at the admin’s prices, with what a model had kept at a tenth", () => {
    const counted = meteredOf(snapshot.usage);
    expect(
      counted.map((each) => `${each.purpose}/${each.model}`).toSorted()
    ).toStrictEqual(["drawing/opus", "interviews/sonnet", "interviews/voice"]);
    const sonnet = counted.find((each) => each.model === "sonnet");
    expect({
      tokensIn: sonnet?.use.tokensIn,
      counted: view.usage.counted,
      drawn: view.usage.matrix.drawing.opus.tokensOut,
      // A snapshot from before the Worker counted reads as nothing counted.
      before: orgOfSnapshot({ ...snapshot, usage: [] }).real?.metered,
    }).toStrictEqual({
      tokensIn: 500_000,
      counted: true,
      drawn: 1500,
      before: [],
    });
    expect(sonnet?.use.spend).toBeCloseTo(
      0.1 * PRICES.sonnet.tokensIn +
        0.4 * PRICES.sonnet.tokensIn * 0.1 +
        0.002 * PRICES.sonnet.tokensOut,
      6
    );
    const voice = counted.find((each) => each.model === "voice");
    expect(voice?.use).toMatchObject({
      spoken: 2,
      spend: 2 * PRICES.voice.minute,
    });
    expect(view.usage.total.spend).toBeCloseTo(
      counted.reduce((sum, each) => sum + each.use.spend, 0),
      6
    );
  });
});
