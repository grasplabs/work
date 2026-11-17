import type { WorkflowVersionRecord } from "@grasp-os/shared/brain-records";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { drainObjectOutbox } from "../src/audit-outbox.ts";
import {
  codeEntitiesAs,
  entitiesAs,
  memoriesAs,
  workBrain,
} from "../src/brain-next.ts";
import type { StoredMemory } from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { eraseOwedOnboardingSources } from "../src/onboarding/new-brain.ts";
import { routineFacts } from "../src/onboarding/routine.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import {
  accountOf,
  aloneInTheStore,
  answering,
  onLink,
} from "./interview-link.ts";
import {
  agree,
  fact,
  fiveToldReply,
  intake,
  mapped,
  openLink,
  rosterOf,
  team,
  told,
  zendeskClaim,
} from "./onboarding-team.ts";
import type { Key, PartJudge } from "./onboarding-team.ts";

// A team's routines in the new Brain (GRA-1749): the drawing of a piece
// of its work, handed to the Brain, filed as a `routine` entity with its
// steps, figures and evidence, resting on the drawing's version. The ways
// it can fail, tried here:
//
// - A step four people told reaching the routine, or a routine standing
//   on a drawing with no step five told.
// - A routine readable by code (an App or a workflow), which the
//   drawing's readers never are.
// - A routine still readable once the drawing it rests on falls: a
//   withdrawal takes it down as it commits, before core's clock.

const clock = { at: Date.now() };

/** A drawing as the Brain keeps it, of one step and nothing else. */
const drawingWithSteps: WorkflowVersionRecord = {
  type: "workflowVersion",
  id: "onb-wfv-0123456789abcdef0123456789abcdef",
  workflowId: "onb-wf-0123456789abcdef0123456789abcdef",
  sourceId: "onb-src-0123456789abcdef0123456789abcdef",
  date: "2026-11-17",
  state: "mapping",
  people: 7,
  starts: "",
  steps: [
    {
      text: "Open the ticket.",
      who: "",
      tool: "",
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
  next: "",
  term: null,
  differs: null,
  volumes: [],
  takes: null,
  wrong: null,
  open: [],
};

/** Hands over what the onboarding noted, through the relay and one tick of the Brain's work. */
const handOverNow = async (into: Env = env): Promise<void> => {
  await runInDurableObject(onboardingStore(env), async (_, state) => {
    await drainObjectOutbox(env, state.storage.sql, 0);
  });
  await relayHandOvers(env);
  clock.at = Math.max(clock.at, Date.now()) + 1;
  await workBrain(into, new Date(clock.at), producersOf(into));
};

/** Past the work queue's first backoff after a failed attempt (work.ts). */
const pastFirstBackoffMs = 61_000;

/**
 * Core's env with the Brain's stores reached through stubs whose first
 * `addMemories` fails: `lost`, made and its answer lost, as a connection
 * dropped on the way back would; `unmade`, refused before it is made, as
 * a store out of reach would. They work from then on. And how many calls
 * they saw.
 */
const filingFailsOnce = (how: "lost" | "unmade") => {
  const seen = { calls: 0 };
  const stubOf = <T extends object>(stub: T): T =>
    new Proxy(stub, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        // An RPC stub's members are its own: called with Reflect.
        return async (...given: unknown[]): Promise<unknown> => {
          const first = name === "addMemories" && seen.calls === 0;
          if (name === "addMemories") {
            seen.calls += 1;
          }
          if (first && how === "unmade") {
            throw new Error("The Brain is out of reach.");
          }
          const answer: unknown = await Reflect.apply(member, target, given);
          if (first) {
            throw new Error("The answer was lost on the way back.");
          }
          return answer;
        };
      },
    });
  const namespaceOf = <T extends object>(namespace: T): T =>
    new Proxy(namespace, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        if (name !== "jurisdiction" && name !== "getByName") {
          return (...given: unknown[]): unknown =>
            Reflect.apply(member, target, given);
        }
        return (argument: unknown): unknown => {
          const made: unknown = Reflect.apply(member, target, [argument]);
          if (typeof made !== "object" || made === null) {
            return made;
          }
          return name === "jurisdiction" ? namespaceOf(made) : stubOf(made);
        };
      },
    });
  const failing: Env = { ...env, BRAIN_STORE: namespaceOf(env.BRAIN_STORE) };
  return { env: failing, seen };
};

/** An address on the list, from a person's id. */
const addressOf = (person: string): string => `${person}@acme.test`;

/** Seven who tell their own work besides Lea, the lead: a team whose results may show. */
const seven: readonly Key[] = [
  "lea",
  "max",
  "mia",
  "mo",
  "noor",
  "pim",
  "rik",
  "sam",
];

/**
 * A team through the onboarding: its tickets drawn as five told them
 * (`fiveToldReply`: Max, Mia, Mo, Noor and Pim), each part checked by
 * `part`, its intake given and handed over to the Brain. Max's account,
 * and the id of the tickets' drawing standing now, if one does.
 */
const drawnTeam = async (part?: PartJudge, into: Env = env) => {
  const ids = await team(seven, addressOf);
  await mapped(ids);
  await told(ids);
  await agree(ids.sam, [fact("s1", "step", "Answers the phone.")]);
  await answering(
    [fiveToldReply(ids)],
    async () => await onboardingStore(env).drawNext()
  );
  const { gave } = await intake(ids, [zendeskClaim], part);
  if (gave !== `brain:${ids.team}`) {
    throw new Error("The team's intake was never given.");
  }
  await handOverNow(into);
  const drawings = await onboardingStore(env).standingDrawings();
  const drawing = drawings.find(
    ({ team: of, name }) => of === ids.team && name === "handling new tickets"
  );
  const max = await accountOf(await openLink(ids.max));
  return { ids, max, drawing: drawing?.source };
};

/** A routine as a member reads it: its name and its memories, each by attribute and value or statement. */
interface ReadRoutine {
  id: string;
  name: string | null;
  memories: StoredMemory[];
}

/**
 * The routine resting on drawing `source`, as the member `userId` reads
 * it on their Brain page: every routine they may see, each page read,
 * and the one whose memories rest on that drawing. None when there is
 * none they may see.
 */
const routineOn = async (
  userId: string,
  source: string
): Promise<ReadRoutine | null> => {
  let from: Parameters<typeof entitiesAs>[2]["from"];
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page after the last
    const page = await entitiesAs(env, userId, {
      kind: "routine",
      ...(from === undefined ? {} : { from }),
    });
    for (const entity of page.items) {
      // oxlint-disable-next-line no-await-in-loop -- one routine at a time
      const { memories } = await memoriesAs(env, userId, {
        entity: { store: entity.store, id: entity.id },
      });
      if (
        memories.some(
          (memory) =>
            memory.source?.source.producer === "drawing" &&
            memory.source.source.id === source
        )
      ) {
        return { id: entity.id, name: entity.name, memories };
      }
    }
    from = page.next ?? undefined;
  } while (from !== undefined);
  return null;
};

/** The values of a routine's memories filed under `attribute`, history included, in the order read: a relation by its entity's name. */
const valuesOf = (routine: ReadRoutine | null, attribute: string): string[] =>
  (routine?.memories ?? []).flatMap((memory) => {
    const said = memory.value ?? memory.object?.name ?? null;
    return memory.attribute === attribute && said !== null ? [said] : [];
  });

/** Texts in their order. */
const byText = (one: string, other: string): number => one.localeCompare(other);

/** The four who back a step in the case of four: Max, Mia, Mo and Noor, by a fact only each of them agreed to. */
const fourOwn = [
  "Opens the ticket in Zendesk.",
  "Would like the customer number filled in for them.",
  "A ticket waits days for the customer's reply.",
  "Reads the ticket first.",
];

/** Whether `facts` are one of those four's. */
const ofTheFour = (facts: readonly string[]): boolean =>
  facts.some((said) => fourOwn.some((own) => said.includes(own)));

describe("routines in the new Brain", { timeout: 120_000 }, () => {
  beforeEach(aloneInTheStore);

  it("file a piece of work five people told as a routine every member reads, with its steps, its figures, its team and how many it rests on", async () => {
    const { max, drawing } = await drawnTeam();
    const routine = await routineOn(max, drawing ?? "");
    expect({
      drawn: drawing !== undefined,
      name: routine?.name,
      // Read in the store's order: each step's value says its place.
      steps: valuesOf(routine, "step").toSorted(byText),
      // The team by its identifier alone: never a name the list may change.
      team: (routine?.memories ?? []).filter(
        ({ attribute, object }) => attribute === "team" && object !== null
      ).length,
      evidence: valuesOf(routine, "evidence"),
      frequency: valuesOf(routine, "frequency").length,
      duration: valuesOf(routine, "duration").length,
    }).toStrictEqual({
      drawn: true,
      name: "handling new tickets",
      // Max alone told the step that asks Noor: it stays out.
      steps: ["1. Open the ticket.", "2. Send the answer."],
      team: 1,
      // Drawn from all seven who tell their own work.
      evidence: ["described by 7 people in interviews"],
      frequency: 1,
      duration: 1,
    });
  });

  it("file a routine once when its filing's answer is lost and its hand-over is tried again", async () => {
    const failing = filingFailsOnce("lost");
    const { max, drawing } = await drawnTeam(undefined, failing.env);
    // The queue tries the hand-over again after its backoff: the same
    // version, and its routine filed under the same change, which answers
    // what the lost call added.
    clock.at += pastFirstBackoffMs;
    await workBrain(failing.env, new Date(clock.at), producersOf(failing.env));
    const routine = await routineOn(max, drawing ?? "");
    expect({
      calls: failing.seen.calls,
      // History included: a step filed twice would show twice.
      steps: valuesOf(routine, "step").toSorted(byText),
    }).toStrictEqual({
      calls: 2,
      steps: ["1. Open the ticket.", "2. Send the answer."],
    });
  });

  it("file a routine whose first filing failed after its team was renamed on the list, before its hand-over is tried again", async () => {
    const failing = filingFailsOnce("unmade");
    const { ids, max, drawing } = await drawnTeam(undefined, failing.env);
    // The admin renames the team before the queue tries again.
    const roster = rosterOf(
      ids,
      seven,
      Object.fromEntries(seven.map((key) => [key, addressOf(ids[key])]))
    );
    await onboardingStore(env).saveRoster(
      {
        ...roster,
        teams: roster.teams.map((each) => ({ ...each, name: "Support" })),
      },
      { type: "system" }
    );
    for (let tick = 0; tick < 4; tick += 1) {
      clock.at += pastFirstBackoffMs * 2 ** tick;
      // oxlint-disable-next-line no-await-in-loop -- one tick at a time, as the clock gives them
      await workBrain(
        failing.env,
        new Date(clock.at),
        producersOf(failing.env)
      );
    }
    const routine = await routineOn(max, drawing ?? "");
    expect({
      calls: failing.seen.calls,
      steps: valuesOf(routine, "step").toSorted(byText),
    }).toStrictEqual({
      calls: 2,
      steps: ["1. Open the ticket.", "2. Send the answer."],
    });
  });

  it("file every count of how often as one figure, as `frequency` holds one value", () => {
    const counts = routineFacts({
      name: "handling new tickets",
      drawing: {
        ...drawingWithSteps,
        volumes: [
          {
            of: "me",
            per: "week",
            low: 30,
            high: 50,
            people: 5,
            basis: "estimated",
          },
          {
            of: "team",
            per: "week",
            low: 200,
            high: 200,
            people: 5,
            basis: "estimated",
          },
        ],
      },
    }).filter(({ attribute }) => attribute === "frequency");
    expect(counts.map(({ value }) => value)).toStrictEqual([
      "30 to 50 a week, each by their own count; about 200 a week, for the whole team",
    ]);
  });

  it("file no routine from a drawing whose steps only four people told", async () => {
    // Only the four's facts back a step: each step rests on four, while
    // everything else of the drawing stands on all who told it.
    const { max, drawing } = await drawnTeam(
      (_part, facts, _work, kind) =>
        kind?.startsWith("A step of the work") !== true || ofTheFour(facts)
    );
    expect({
      drawn: drawing !== undefined,
      routine: await routineOn(max, drawing ?? ""),
    }).toStrictEqual({ drawn: true, routine: null });
  });

  it("give code, as an App or a workflow, no routine a member reads", async () => {
    const { max, drawing } = await drawnTeam();
    const routine = await routineOn(max, drawing ?? "");
    const found = await codeEntitiesAs(env, max, "company", {
      kind: "routine",
    });
    expect({
      member: routine !== null,
      code: found.entities.some(({ id }) => id === routine?.id),
    }).toStrictEqual({ member: true, code: false });
  });

  it("take a routine down as a withdrawal of someone it rests on commits, and leave nothing of it once the drawing is erased", async () => {
    const { ids, max, drawing } = await drawnTeam();
    const before = await routineOn(max, drawing ?? "");
    await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
    const withdrawn = await routineOn(max, drawing ?? "");
    await eraseOwedOnboardingSources(env);
    expect({
      before: before !== null,
      withdrawn,
      erased: await routineOn(max, drawing ?? ""),
    }).toStrictEqual({ before: true, withdrawn: null, erased: null });
  });
});
