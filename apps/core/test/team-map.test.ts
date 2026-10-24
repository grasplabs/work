import { sha256Hex } from "@grasp-os/shared/encoding";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { assignWork, mapOf } from "../src/onboarding/team-map.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { answering, careful, modelOf } from "./interview-link.ts";
import { routed, unique } from "./sign-in.ts";

// A team's map (src/onboarding/team-map.ts and the store's drawing): once
// a lead agrees to their interview, the careful model draws the team's
// pieces of work and who does which, and everyone in the team is asked
// about one. AI Gateway is the outside system, faked behind the AI
// binding. The ways it can fail, tried here:
//
// - The team's links staying shut after the lead agreed, or opening before.
// - Something the lead agreed to while the map was drawn going undrawn.
// - A drawing that keeps failing holding the team up for good.
// - A lead who never talks holding their team up for good.

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sessionKey = z.object({ key: z.string().optional() });
const staff = { type: "staff", userId: "staff-test" } as const;

/**
 * Cancels the store's alarm: these tests release links and draw by hand.
 * The alarm releases and draws whatever is due too, so on a slow run it
 * can draw a map between a test's own steps, and the links it opens then
 * aren't the test's to see.
 */
const withoutAlarm = async (): Promise<void> => {
  await runInDurableObject(onboardingStore(env), async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
};

/** A team led by Lea, with Max and Mia, in a fresh onboarding running from `start`. */
const team = async (start: string) => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    team: `ops-${id}`,
    lea: `lea-${id}`,
    max: `max-${id}`,
    mia: `mia-${id}`,
  };
  const person = (key: "lea" | "max" | "mia", name: string, title: string) => ({
    id: ids[key],
    name,
    team: ids.team,
    email: "",
    title,
    away: false,
  });
  const roster: Roster = {
    teams: [{ id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false }],
    people: [
      person("lea", "Lea Lind", "Team lead"),
      person("max", "Max Mol", "Agent"),
      person("mia", "Mia Moor", "Agent"),
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan({ start, days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await withoutAlarm();
  return ids;
};

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

const agreed = (id: string, record: string): InterviewFact => ({
  id,
  tag: "work",
  text: record,
  record,
  agreed: true,
});

/** Saves the lead's interview as agreed to, with `facts`; returns the new version. */
const agree = async (
  link: { secret: string; key: string },
  version: number,
  facts: InterviewFact[]
): Promise<number> => {
  const progress: InterviewProgress = {
    person: "completed",
    told: true,
    mode: "type",
    lines: [{ from: "stephen", text: "What does your team do?" }],
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
    body: JSON.stringify({ action: "save", ...link, version, progress }),
  });
  const saved: InterviewSaved = await response.json();
  return saved.version;
};

/** What the careful model answers: a map with tickets (Max and Mia) and the rota (Lea). */
const mapReply = (
  ids: { lea: string; max: string; mia: string },
  more: Partial<Extract<GatewayReply, { text: string }>> = {}
): GatewayReply => ({
  text: JSON.stringify({
    does: "Answers customers' questions",
    works: [
      {
        name: "Handling new tickets",
        local: "Nieuwe tickets afhandelen",
        one: "ticket",
        many: "tickets",
        doers: [ids.max, ids.mia, "someone-else"],
        share: 0.7,
      },
      {
        name: "planning the rota",
        local: "het rooster plannen",
        one: "rota",
        many: "rotas",
        doers: [ids.lea],
        share: 0.3,
      },
    ],
  }),
  inputTokens: 2000,
  outputTokens: 300,
  ...more,
});

/** Whose links went out just now, whether the lead is due, and the team's pieces of work. */
const stateOf = async (ids: { team: string; lea: string }) => {
  const store = onboardingStore(env);
  const opened = await store.releaseDue();
  const due = await store.drawsDue();
  const works = await store.teamWorks(ids.team);
  return {
    opened,
    due: due.includes(ids.lea),
    ids: works.map(({ id }) => id),
  };
};

const refused: GatewayReply = {
  status: 400,
  errorType: "invalid_request_error",
};

describe("a team's map", { timeout: 60_000 }, () => {
  it("is drawn once the lead agrees, by the careful model, and opens the team's links with their work", async () => {
    const store = onboardingStore(env);
    const ids = await team(isoDay(Date.now() - dayMs));
    const first = await store.releaseDue();
    const lea = await openLink(ids.lea);
    await agree(lea, 0, [
      agreed("f1", "Max and Mia handle new tickets."),
      agreed("f2", "Lea plans the rota."),
    ]);
    const { requests, result: drew } = await answering(
      [mapReply(ids)],
      async () => {
        const item = await store.drawNext();
        return item;
      }
    );
    const opened = await store.releaseDue();
    const max = await openLink(ids.max);
    const context = await store.turnContext(
      await sha256Hex(max.secret),
      await sha256Hex(max.key)
    );
    const usage = await store.usage();
    const works = await store.teamWorks(ids.team);
    const due = await store.drawsDue();
    expect({
      first,
      drew,
      models: requests.map(modelOf),
      opened,
      works: works.map(({ name, local, doers, share, asked }) => ({
        name,
        local,
        doers,
        share,
        asked,
      })),
      work: context.ok ? context.value.work : null,
      due: due.includes(ids.lea),
      drawing: usage.some(
        ({ purpose, model }) => purpose === "drawing" && model === careful
      ),
    }).toStrictEqual({
      first: [ids.lea],
      drew: `team:${ids.team}`,
      models: ["claude-opus-4-8"],
      opened: [ids.max, ids.mia],
      works: [
        {
          name: "handling new tickets",
          local: "nieuwe tickets afhandelen",
          doers: [ids.max, ids.mia],
          share: 0.7,
          asked: [ids.max, ids.mia],
        },
        {
          name: "planning the rota",
          local: "het rooster plannen",
          doers: [ids.lea],
          share: 0.3,
          asked: [],
        },
      ],
      work: "nieuwe tickets afhandelen",
      due: false,
      drawing: true,
    });
  });

  it("is drawn again when the lead agreed to more while it was drawn, keeping its pieces and who was asked", async () => {
    const store = onboardingStore(env);
    const ids = await team(isoDay(Date.now() - dayMs));
    await store.releaseDue();
    const lea = await openLink(ids.lea);
    const facts = [agreed("f1", "Max and Mia handle new tickets.")];
    const version = await agree(lea, 0, facts);
    const { promise: until, resolve: release } = Promise.withResolvers();
    const { result } = await answering(
      [
        mapReply(ids, {
          pause: {
            at: 10,
            until,
            reached: () => {
              // The lead adds something and agrees, while the map is drawn.
              void (async () => {
                await agree(lea, version, [
                  ...facts,
                  agreed("f2", "Lea plans the rota."),
                ]);
                release(null);
              })();
            },
          },
        }),
        mapReply(ids),
      ],
      async () => {
        await store.drawNext();
        const between = await stateOf(ids);
        await store.drawNext();
        const after = await stateOf(ids);
        return { between, ...after };
      }
    );
    expect({
      before: {
        opened: result.between.opened,
        due: result.between.due,
        works: result.between.ids.length,
      },
      after: { opened: result.opened, due: result.due },
      kept: result.ids,
    }).toStrictEqual({
      before: { opened: [], due: true, works: 2 },
      after: { opened: [ids.max, ids.mia], due: false },
      kept: result.between.ids,
    });
  });

  it("is tried again after a minute, five and thirty, then given up and logged, opening the team; staff can draw it again", async () => {
    const store = onboardingStore(env);
    const ids = await team(isoDay(Date.now() - dayMs));
    await store.releaseDue();
    const lea = await openLink(ids.lea);
    await agree(lea, 0, [agreed("f1", "Max and Mia handle new tickets.")]);
    const now = Date.now();
    const minute = 60_000;
    const { requests, result } = await answering(
      [refused, refused, refused, refused],
      async () => [
        await store.drawNext(now),
        // Not yet: it waits a minute.
        await store.drawNext(now + minute / 2),
        await store.drawNext(now + minute + 1),
        await store.drawNext(now + 7 * minute),
        await store.drawNext(now + 38 * minute),
      ]
    );
    const opened = await store.releaseDue();
    const dueBefore = await store.drawsDue();
    const dueAfter = dueBefore.includes(ids.lea);
    const again = await store.drawAgain(ids.team, staff);
    const dueNow = await store.drawsDue();
    const { entries } = await store.staffLog({ what: "map" });
    const log = entries.filter(({ person }) => person?.id === ids.lea);
    expect({
      result,
      calls: requests.length,
      opened,
      log: log.map(({ what }) => what),
      dueAfter,
      again,
      dueAgain: dueNow.includes(ids.lea),
    }).toStrictEqual({
      result: [
        `team:${ids.team}`,
        null,
        `team:${ids.team}`,
        `team:${ids.team}`,
        `team:${ids.team}`,
      ],
      calls: 4,
      opened: [ids.max, ids.mia],
      log: [
        "map.again",
        "map.gave_up",
        "map.failed",
        "map.failed",
        "map.failed",
      ],
      dueAfter: false,
      again: true,
      dueAgain: true,
    });
  });

  it("opens a team whose lead never talks on the fourth working day", async () => {
    const store = onboardingStore(env);
    // A Monday in the future, so the moments are the test's own.
    const ids = await team("2030-01-07");
    expect({
      monday: await store.releaseDue("2030-01-07T12:00:00.000Z"),
      wednesday: await store.releaseDue("2030-01-09T12:00:00.000Z"),
      thursday: await store.releaseDue("2030-01-10T12:00:00.000Z"),
    }).toStrictEqual({
      monday: [ids.lea],
      wednesday: [],
      thursday: [ids.max, ids.mia],
    });
  });
});

/** Someone in a team, by id, with their job. */
const person = (id: string, title = "") => ({ id, name: id, title });

describe("who is asked about which piece of work", () => {
  it("asks whoever the lead named about their work, and the rest by share, so every piece is heard", () => {
    const assigned = assignWork(
      [person("a"), person("b"), person("c"), person("d")],
      [
        { id: "tickets", doers: ["a"], share: 0.6 },
        { id: "rota", doers: [], share: 0.4 },
      ]
    );
    // Those the lead didn't name go first, to the least heard by share.
    expect(Object.fromEntries(assigned)).toStrictEqual({
      a: "tickets",
      b: "tickets",
      c: "rota",
      d: "tickets",
    });
  });

  it("asks someone the lead didn't name about the work of people with their job", () => {
    const everyone = [person("a", "Agent"), person("b", "Agent")];
    const assigned = assignWork(
      [person("b", "Agent")],
      [
        { id: "tickets", doers: ["a"], share: 0.2 },
        { id: "rota", doers: [], share: 0.8 },
      ],
      everyone
    );
    expect(assigned.get("b")).toBe("tickets");
  });

  it("asks nobody about anything when the map has no work", () => {
    expect(assignWork([person("a")], []).get("a")).toBeNull();
  });
});

describe("the map as drawn", () => {
  it("keeps only people on the list, names in lower case, and shares that add up to one", () => {
    const map = mapOf(
      {
        does: "  Answers   customers ",
        works: [
          {
            name: "Handling Tickets",
            local: "",
            one: "",
            many: "",
            doers: ["a", "x"],
            share: 3,
          },
          { name: "  ", local: "x", one: "x", many: "x", doers: [], share: 1 },
          {
            name: "rota",
            local: "rooster",
            one: "rota",
            many: "rotas",
            doers: [],
            share: 1,
          },
        ],
      },
      [{ id: "a" }]
    );
    expect(map).toStrictEqual({
      does: "Answers customers",
      works: [
        {
          name: "handling tickets",
          local: "handling tickets",
          one: "item",
          many: "items",
          doers: ["a"],
          share: 0.5,
        },
        {
          name: "rota",
          local: "rooster",
          one: "rota",
          many: "rotas",
          doers: [],
          share: 0.5,
        },
      ],
    });
  });
});
