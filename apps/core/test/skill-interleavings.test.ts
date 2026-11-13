import type { AuditEvent } from "@grasp-os/shared/audit";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { readCurrentSkillAs, sharedChangeVersion } from "../src/brain-next.ts";
import { skillsFor } from "../src/brain-skills.ts";
import {
  skillDecisions,
  skillDeletions,
  skillShares,
} from "../src/db/core/schema.ts";
import { retryErasures } from "../src/person-erasure.ts";
import {
  approveShare,
  declineShare,
  reconcileSkills,
  removeOwnSkill,
  retireSkill,
  saveOwnSkill,
  shareOwnSkill,
} from "../src/skill-shares.ts";
import { eventsAfterWithHead, logHead } from "./audit-events.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { holdsNothing } from "./stored-skills.ts";

// Sharing skills, every step of every operation held while another runs,
// failed, or its reply lost (GRA-1754, from review round 9's probe): the
// reconciler's claim, by breaking things. Each operation runs through
// core's own functions with an env whose Brain stores' calls and D1 calls
// are numbered steps. After each sequence the clock runs (the reconciler,
// the erasures), then what must hold:
//
// - the Brain's live text for the name is the latest decision's, and that
//   decision landed;
// - each decision has exactly one outcome event, agreeing with the store;
//   none says a version the store doesn't have for it;
// - no closed share (asked again, deleted, of a removed person, declined)
//   was ever decided, and no share waits of a deleted skill or a removed
//   person; no decision of a skill's text is made after its deletion;
// - nothing personal reaches anyone else: no member is given the person's
//   own skill, and no event holds a skill's text.
//
// Deterministic: a fixed sweep (each of approving, asking again, retiring
// and deleting held before each of its steps while one of those or a
// removal runs; each failing before, or losing the reply after, each of
// its steps), each finding of the round as its own sequence, and seeded
// random sequences of two holds.

const idp = mockIdp();

/** Every sequence is short; the whole sweep is what takes time. */
const sweepTime = { timeout: 600_000 };

type Op =
  | "approve"
  | "askAgain"
  | "askOld"
  | "otherAsk"
  | "retire"
  | "delete"
  | "remove"
  | "erase"
  | "decline";

/** What happens at a step of an operation. */
type Kind = "hold" | "fail" | "lose";

interface Placement {
  /** The operation (its index in the sequence) whose step it is. */
  op: number;
  /** Its step, from 1. */
  step: number;
  kind: Kind;
  /** For a hold: the operations run there, in order. */
  inner?: number[];
}

interface Sequence {
  ops: Op[];
  placements: Placement[];
}

interface Person {
  userId: string;
  name: string;
  ident: Identity;
  api: Awaited<ReturnType<typeof signedInApi>>["api"];
}

const personOf = async (role: "user" | "admin"): Promise<Person> => {
  const signedIn = await signedInApi(idp, role);
  return {
    userId: signedIn.userId,
    name: String(signedIn.person.name),
    ident: await signedIn.api.whoami(),
    api: signedIn.api,
  };
};

let people: { first: Person; second: Person; member: Person } | undefined;

/** The admins and the member every sequence of a test shares. */
const shared = async () => {
  people ??= {
    first: await personOf("admin"),
    second: await personOf("admin"),
    member: await personOf("user"),
  };
  return people;
};

interface World {
  name: string;
  asker: Person;
  first: Person;
  second: Person;
  member: Person;
  saves: number;
  /** The last share asked, as a card an admin may still click. */
  lastShare: string | undefined;
  removed: boolean;
  erased: boolean;
  /** When the skill's deletion returned, if it did. */
  deletedAt: number | undefined;
  /** Every text the asker saved: theirs, deleted with the skill. */
  texts: Set<string>;
  /** A second person, who asks to share their own skill of the same name and text. */
  other: Person | undefined;
  /** Every hold's operations, awaited before anything is checked. */
  holds: Promise<unknown>[];
}

const textOf = (name: string, tag: string) =>
  `---\nname: ${name}\ndescription: d-${tag}\n---\n\nsteps-${tag}\n`;

/** How an operation's numbered steps behave: told before and after each. */
type OnStep = (
  step: number,
  phase: "before" | "after"
) => Promise<"fail" | "lose" | undefined>;

/**
 * Core's env whose Brain stores' calls and D1 calls are numbered steps,
 * each of which `onStep` may hold, fail or lose the reply of.
 */
const steppedEnv = (onStep: OnStep): { env: Env; steps: () => number } => {
  let count = 0;
  const run = async <T>(call: () => Promise<T>): Promise<T> => {
    count += 1;
    const step = count;
    if ((await onStep(step, "before")) === "fail") {
      throw new Error("Out of reach, for the test");
    }
    const answered = await call();
    if ((await onStep(step, "after")) === "lose") {
      throw new Error("Reply lost, for the test");
    }
    return answered;
  };
  const binding = env.BRAIN_STORE;
  const getByName = (named: string) => {
    const stub = binding.getByName(named);
    return new Proxy(stub, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function" || typeof property !== "string") {
          return value;
        }
        return async (...args: unknown[]): Promise<unknown> =>
          await run(async () => {
            const answered: unknown = await Reflect.apply(value, target, args);
            return answered;
          });
      },
    });
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  /** The audit outbox's own statements: its background drain, never the operation's steps. */
  const outbox = new WeakSet<object>();
  const wrap = (
    statement: D1PreparedStatement,
    query: string
  ): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get: (target, property): unknown => {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const step = ["first", "all", "raw", "run"].includes(String(property));
        if (step && !outbox.has(proxy)) {
          return async (...args: unknown[]): Promise<unknown> =>
            await run(async () => {
              const answered: unknown = await Reflect.apply(
                value,
                target,
                args
              );
              return answered;
            });
        }
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      },
    });
    real.set(proxy, statement);
    if (query.includes("audit_outbox") && !query.includes("changes()")) {
      outbox.add(proxy);
    }
    return proxy;
  };
  const database = env.DB;
  return {
    env: {
      ...env,
      BRAIN_STORE: new Proxy(binding, {
        get: (target, property): unknown =>
          property === "getByName" ? getByName : Reflect.get(target, property),
      }),
      DB: new Proxy(database, {
        get: (target, property): unknown => {
          if (property === "prepare") {
            return (query: string) => wrap(target.prepare(query), query);
          }
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              const write = async () =>
                await target.batch(
                  statements.map((each) => real.get(each) ?? each)
                );
              return statements.every((each) => outbox.has(each))
                ? await write()
                : await run(write);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      }),
    },
    steps: () => count,
  };
};

/** The newest share of the name waiting now, as the admin's card shows it; else the last one asked. */
const cardOf = async (w: World): Promise<string> => {
  const [waiting] = await drizzle(env.DB)
    .select({ id: skillShares.id })
    .from(skillShares)
    .where(and(eq(skillShares.name, w.name), eq(skillShares.status, "pending")))
    .orderBy(desc(skillShares.requestedAt))
    .limit(1);
  return waiting?.id ?? w.lastShare ?? crypto.randomUUID();
};

/** Saves a new text of the asker's skill, outside any steps. */
const saveNew = async (w: World): Promise<number> => {
  w.saves += 1;
  const text = textOf(w.name, `${w.saves}`);
  w.texts.add(text);
  const saved = await saveOwnSkill(env, w.asker.ident, text);
  return saved.version;
};

/** Operation `op` in `w`, on `e`. */
const operation = async (w: World, op: Op, e: Env): Promise<void> => {
  switch (op) {
    case "approve": {
      await approveShare(e, w.first.ident, await cardOf(w));
      return;
    }
    case "decline": {
      await declineShare(e, w.first.ident, await cardOf(w));
      return;
    }
    case "askAgain": {
      const version = await saveNew(w);
      const asked = await shareOwnSkill(
        e,
        w.asker.ident,
        w.name,
        version,
        "company"
      );
      w.lastShare = asked.id;
      return;
    }
    case "askOld": {
      // Its first version: the text that is live.
      const asked = await shareOwnSkill(e, w.asker.ident, w.name, 1, "company");
      w.lastShare = asked.id;
      return;
    }
    case "otherAsk": {
      w.other ??= await personOf("user");
      const saved = await saveOwnSkill(env, w.other.ident, textOf(w.name, "1"));
      const asked = await shareOwnSkill(
        e,
        w.other.ident,
        w.name,
        saved.version,
        "company"
      );
      w.lastShare = asked.id;
      return;
    }
    case "retire": {
      await retireSkill(e, w.second.ident, w.name, "company");
      return;
    }
    case "delete": {
      await removeOwnSkill(e, w.asker.ident, w.name);
      w.deletedAt = Date.now();
      return;
    }
    case "remove": {
      if (!w.removed) {
        w.removed = true;
        await w.first.api.members.remove(w.asker.userId);
      }
      return;
    }
    case "erase": {
      if (!w.removed) {
        w.removed = true;
        await w.first.api.members.remove(w.asker.userId);
      }
      w.erased = true;
      await w.first.api.members.erase(w.asker.userId, w.asker.name);
      return;
    }
    default: {
      throw new Error("Unknown operation");
    }
  }
};

/** Runs operation `index` of `s`, with its placements, and the operations its holds run. */
const runOp = async (w: World, s: Sequence, index: number): Promise<number> => {
  const mine = s.placements.filter(({ op }) => op === index);
  const stepped = steppedEnv(async (step, phase) => {
    const here = mine.filter((placement) => placement.step === step);
    if (phase === "before") {
      for (const { inner } of here.filter(({ kind }) => kind === "hold")) {
        const held = (async () => {
          for (const each of inner ?? []) {
            // oxlint-disable-next-line no-await-in-loop -- in order, inside the hold
            await runOp(w, s, each);
          }
        })();
        w.holds.push(held);
        // oxlint-disable-next-line no-await-in-loop -- the step waits for its hold
        await held;
      }
    }
    const wanted = phase === "before" ? "fail" : "lose";
    return here.some(({ kind }) => kind === wanted) ? wanted : undefined;
  });
  const op = s.ops[index];
  if (op !== undefined) {
    await outcome(operation(w, op, stepped.env));
  }
  return stepped.steps();
};

/**
 * A new person with a skill shared and added, a newer text of it asked
 * and waiting, and a newer one still saved: every operation has something
 * to act on.
 */
const worldOf = async (): Promise<World> => {
  const { first, second, member } = await shared();
  const w: World = {
    name: `mix-${unique()}`,
    asker: await personOf("user"),
    first,
    second,
    member,
    saves: 0,
    lastShare: undefined,
    removed: false,
    erased: false,
    deletedAt: undefined,
    texts: new Set(),
    other: undefined,
    holds: [],
  };
  const added = await shareOwnSkill(
    env,
    w.asker.ident,
    w.name,
    await saveNew(w),
    "company"
  );
  await approveShare(env, first.ident, added.id);
  const waiting = await shareOwnSkill(
    env,
    w.asker.ident,
    w.name,
    await saveNew(w),
    "company"
  );
  w.lastShare = waiting.id;
  await saveNew(w);
  return w;
};

const stepsTag = /steps-(?<tag>\S+)/u;

/** The skill's text in `text`, short, or null. */
const tagOf = (text: string | null | undefined): string | null =>
  text === null || text === undefined
    ? null
    : (stepsTag.exec(text)?.groups?.tag ?? "?");

const countOf = (events: readonly AuditEvent[], action: string, id: string) =>
  events.filter(
    (event) => event.action === action && String(event.target?.id) === id
  );

type DecisionRow = typeof skillDecisions.$inferSelect;
type ShareRow = typeof skillShares.$inferSelect;

/** What members read of the company's skill `w.name`: its text, or null. */
const liveTextOf = async (w: World): Promise<string | null> => {
  const read = await readCurrentSkillAs(env, w.member.userId, {
    scope: "company",
    name: w.name,
  });
  return read?.text ?? null;
};

/** That the Brain follows the latest decision, and it landed. */
const liveViolations = async (
  w: World,
  decisions: readonly DecisionRow[]
): Promise<string[]> => {
  const latest = decisions.at(-1);
  const expected =
    latest === undefined || latest.shareId === null ? null : latest.text;
  const live = await liveTextOf(w);
  return [
    ...(live === expected
      ? []
      : [`live ${tagOf(live)}, the latest decision says ${tagOf(expected)}`]),
    ...(latest === undefined || latest.outcome === "landed"
      ? []
      : [`the latest decision is ${latest.outcome ?? "on its way"}`]),
  ];
};

/** That `decision`'s outcome is the store's, said once, of a share open when decided. */
const decisionViolations = async (
  w: World,
  decision: DecisionRow,
  shares: readonly ShareRow[],
  events: readonly AuditEvent[]
): Promise<string[]> => {
  const found: string[] = [];
  const made = await sharedChangeVersion(env, {
    audience: { kind: "company" },
    name: w.name,
    change: `decision:${decision.id}`,
  });
  const landedAs = decision.outcome === "landed" ? decision.version : null;
  if (decision.outcome === null || made !== landedAs) {
    found.push(
      `decision ${decision.seq} says ${decision.outcome ?? "nothing"} ${landedAs}, the store made ${made}`
    );
  }
  if (decision.shareId === null) {
    return found;
  }
  const { shareId } = decision;
  const approved = countOf(events, "skill.share.approved", shareId);
  const added = countOf(events, "skill.share.added", shareId);
  const superseded = countOf(events, "skill.share.superseded", shareId);
  if (approved.length !== 1 || added.length + superseded.length !== 1) {
    found.push(
      `decision ${decision.seq}: ${approved.length} approved, ${added.length} added, ${superseded.length} superseded`
    );
  }
  if (added.some(({ detail }) => detail?.version !== decision.version)) {
    found.push(`decision ${decision.seq}'s added event says another version`);
  }
  const share = shares.find(({ id }) => id === shareId);
  if (share === undefined ? !w.erased : share.status !== "approved") {
    found.push(`decision ${decision.seq} is of a closed share`);
  }
  const afterDeletion =
    w.deletedAt !== undefined && decision.decidedAt.getTime() > w.deletedAt;
  const askers = share?.requestedBy === w.asker.userId;
  if (afterDeletion && askers && w.texts.has(decision.text)) {
    found.push(`decision ${decision.seq} decided a deleted skill's text`);
  }
  return found;
};

/** That each retirement has its decision event and one outcome. */
const retirementViolations = (
  w: World,
  decisions: readonly DecisionRow[],
  events: readonly AuditEvent[]
): string[] => {
  const retirements = decisions.filter(({ shareId }) => shareId === null);
  const of = (action: string) => countOf(events, action, w.name).length;
  const outcomes = of("skill.retire_done") + of("skill.retire_superseded");
  return of("skill.retired") === retirements.length &&
    outcomes === retirements.length
    ? []
    : [
        `${retirements.length} retirements, ${of("skill.retired")} retired events, ${outcomes} outcomes`,
      ];
};

/** That nothing of the person outlives what they did, and nothing personal reaches anyone else. */
const personalViolations = async (
  w: World,
  shares: readonly ShareRow[],
  events: readonly AuditEvent[]
): Promise<string[]> => {
  const found: string[] = [];
  const theirs = shares.filter(
    ({ requestedBy }) => requestedBy === w.asker.userId
  );
  const waiting = theirs.some(({ status }) => status === "pending");
  if (waiting && (w.removed || w.deletedAt !== undefined)) {
    found.push(
      `a share waits of a ${w.removed ? "removed person" : "deleted skill"}`
    );
  }
  if (w.erased && theirs.length > 0) {
    found.push("an erased person's share is kept");
  }
  const deletions = await drizzle(env.DB)
    .select({ name: skillDeletions.name })
    .from(skillDeletions)
    .where(eq(skillDeletions.personId, w.asker.userId));
  if (w.erased && deletions.length > 0) {
    found.push("an erased person's deletion is kept");
  }
  if (events.some((event) => JSON.stringify(event).includes("steps-"))) {
    found.push("an event holds a skill's text");
  }
  const memberSees = await skillsFor(
    env,
    actingFor({ type: "agent", agentId: `agent-${unique()}` }, w.member.userId),
    "person",
    holdsNothing
  );
  if (
    memberSees.some(({ name, scope }) => name === w.name && scope === "person")
  ) {
    found.push("a member is given the person's own skill");
  }
  return found;
};

/** What doesn't hold in `w` once the clock has run: none, if all does. */
const violationsOf = async (w: World, head: number): Promise<string[]> => {
  await reconcileSkills(env);
  await reconcileSkills(env);
  if (w.erased) {
    await retryErasures(env);
  }
  const db = drizzle(env.DB);
  const decisions = await db
    .select()
    .from(skillDecisions)
    .where(eq(skillDecisions.name, w.name))
    .orderBy(asc(skillDecisions.seq));
  const shares = await db
    .select()
    .from(skillShares)
    .where(eq(skillShares.name, w.name));
  const { events } = await eventsAfterWithHead(head);
  const each = await Promise.all(
    decisions.map(
      async (decision) => await decisionViolations(w, decision, shares, events)
    )
  );
  return [
    ...(await liveViolations(w, decisions)),
    ...each.flat(),
    ...retirementViolations(w, decisions, events),
    ...(await personalViolations(w, shares, events)),
  ];
};

/** Runs `s` in a new world: its violations, described. */
const runSequence = async (s: Sequence): Promise<string[]> => {
  const head = await logHead();
  const w = await worldOf();
  const inner = new Set(
    s.placements.flatMap((placement) => placement.inner ?? [])
  );
  for (const [index] of s.ops.entries()) {
    if (!inner.has(index)) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await runOp(w, s, index);
    }
  }
  // Every hold's operations have ended before anything is checked.
  for (let seen = 0; seen < w.holds.length; seen = w.holds.length) {
    // oxlint-disable-next-line no-await-in-loop -- until no new hold starts
    await Promise.all(w.holds);
  }
  const violations = await violationsOf(w, head);
  return violations.map(
    (violation) =>
      `${s.ops.join(",")} ${JSON.stringify(s.placements)}: ${violation}`
  );
};

/** How many steps operation `op` takes alone, in a new world. */
const stepsOf = async (op: Op): Promise<number> => {
  const w = await worldOf();
  return await runOp(w, { ops: [op], placements: [] }, 0);
};

/** What holding, failing or losing can be swept over: those with steps of their own. */
const outers: readonly [Op, ...Op[]] = [
  "approve",
  "askAgain",
  "askOld",
  "retire",
  "delete",
];
const inners: readonly [Op, ...Op[]] = [
  "approve",
  "askAgain",
  "retire",
  "delete",
  "remove",
];

/**
 * What runs inside a hold: one operation, or an ask then its approval
 * (asked again; the live text asked again; another person's ask of the
 * same text), so a newer decision is made while an older one is held.
 */
const innerGroups: readonly (readonly Op[])[] = [
  ...inners.map((op) => [op]),
  ["askAgain", "approve"],
  ["askOld", "approve"],
  ["otherAsk", "approve"],
];

/** Park and Miller's minimal standard generator: the same numbers from the same seed, everywhere. */
const rng = (seed: number) => {
  const modulus = 2_147_483_647;
  let state = seed % modulus || 1;
  return () => {
    state = (state * 16_807) % modulus;
    return (state - 1) / (modulus - 1);
  };
};

/** A sequence of three operations and two holds, from `seed`. */
const seeded = (seed: number): Sequence => {
  const next = rng(seed);
  const pick = <T>(of: readonly [T, ...T[]]): T =>
    of[Math.floor(next() * of.length)] ?? of[0];
  return {
    ops: [
      pick(outers),
      pick([...inners, "decline", "erase"] as const),
      pick(inners),
    ],
    placements: [
      { op: 0, step: 1 + Math.floor(next() * 8), kind: "hold", inner: [1] },
      { op: 0, step: 1 + Math.floor(next() * 8), kind: "hold", inner: [2] },
    ],
  };
};

describe("sharing skills, every step against every other", () => {
  // Each test's sessions are its own: people are signed in again for it.
  beforeEach(() => {
    people = undefined;
  });

  it("holds each finding of review rounds 9 and 10", sweepTime, async () => {
    const findings: Sequence[] = [
      // 1: an approval held while its person asks again and another admin
      // approves the new ask, and with a retirement inside too.
      {
        ops: ["approve", "askAgain", "approve"],
        placements: [{ op: 0, step: 1, kind: "hold", inner: [1, 2] }],
      },
      {
        ops: ["approve", "askAgain", "approve", "retire"],
        placements: [{ op: 0, step: 1, kind: "hold", inner: [1, 2, 3] }],
      },
      // 2: a lost reply of an add (approving's step 6) and of a
      // retirement (retiring's step 6), and a failed record of an add
      // (approving's step 7).
      { ops: ["approve"], placements: [{ op: 0, step: 6, kind: "lose" }] },
      { ops: ["approve"], placements: [{ op: 0, step: 7, kind: "fail" }] },
      { ops: ["retire"], placements: [{ op: 0, step: 6, kind: "lose" }] },
      // 3: a deletion failing after it took the share away, then approving.
      {
        ops: ["delete", "approve"],
        placements: [{ op: 0, step: 2, kind: "fail" }],
      },
      // 4: an approval racing its person's erasure.
      {
        ops: ["approve", "erase"],
        placements: [{ op: 0, step: 3, kind: "hold", inner: [1] }],
      },
      // 5: a removed person's waiting share, then an approval.
      { ops: ["remove", "approve"], placements: [] },
      // A deletion held before its batch while its person is removed and
      // erased: nothing of theirs is written after.
      {
        ops: ["delete", "erase"],
        placements: [{ op: 0, step: 1, kind: "hold", inner: [1] }],
      },
      // Round 10: a newer decision of the text that is live, made while an
      // older one is held at each of its steps: the live text asked again
      // or another person's identical ask, approved; a retirement held the
      // same way; and an approval held over an already retired skill while
      // it is retired again.
      ...Array.from({ length: 10 }, (_, at): Sequence[] => [
        {
          ops: ["approve", "askOld", "approve"],
          placements: [{ op: 0, step: at + 1, kind: "hold", inner: [1, 2] }],
        },
        {
          ops: ["approve", "otherAsk", "approve"],
          placements: [{ op: 0, step: at + 1, kind: "hold", inner: [1, 2] }],
        },
        {
          ops: ["retire", "askOld", "approve"],
          placements: [{ op: 0, step: at + 1, kind: "hold", inner: [1, 2] }],
        },
        {
          ops: ["retire", "approve", "retire"],
          placements: [{ op: 1, step: at + 1, kind: "hold", inner: [2] }],
        },
      ]).flat(),
    ];
    const violations: string[] = [];
    for (const s of findings) {
      // oxlint-disable-next-line no-await-in-loop -- a world at a time
      violations.push(...(await runSequence(s)));
    }
    expect(violations).toStrictEqual([]);
  });

  it(
    "holds when each operation is held at each step while another runs",
    sweepTime,
    async () => {
      const violations: string[] = [];
      let runs = 0;
      for (const outer of outers) {
        // oxlint-disable-next-line no-await-in-loop -- a world at a time
        const steps = await stepsOf(outer);
        for (const group of innerGroups) {
          for (let step = 1; step <= steps; step += 1) {
            // oxlint-disable-next-line no-await-in-loop -- a world at a time
            const found = await runSequence({
              ops: [outer, ...group],
              placements: [
                {
                  op: 0,
                  step,
                  kind: "hold",
                  inner: group.map((_, at) => at + 1),
                },
              ],
            });
            violations.push(...found);
            runs += 1;
          }
        }
      }
      expect({ violations, ran: runs > 0 }).toStrictEqual({
        violations: [],
        ran: true,
      });
    }
  );

  it(
    "holds when each operation fails before, or loses the reply after, each step",
    sweepTime,
    async () => {
      const violations: string[] = [];
      for (const outer of outers) {
        // oxlint-disable-next-line no-await-in-loop -- a world at a time
        const steps = await stepsOf(outer);
        for (let step = 1; step <= steps; step += 1) {
          for (const kind of ["fail", "lose"] as const) {
            // oxlint-disable-next-line no-await-in-loop -- a world at a time
            const found = await runSequence({
              ops: [outer],
              placements: [{ op: 0, step, kind }],
            });
            violations.push(...found);
          }
        }
      }
      expect(violations).toStrictEqual([]);
    }
  );

  it(
    "holds over seeded sequences of three operations and two holds",
    sweepTime,
    async () => {
      const violations: string[] = [];
      for (let seed = 1; seed <= 12; seed += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a world at a time
        violations.push(...(await runSequence(seeded(seed))));
      }
      expect(violations).toStrictEqual([]);
    }
  );
});
