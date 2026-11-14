import type { AuditEvent } from "@grasp-os/shared/audit";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { readCurrentSkillAs, sharedChangeVersion } from "../src/brain-next.ts";
import type { Skill, SkillAudience } from "../src/brain-next.ts";
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
  waitingShares,
} from "../src/skill-shares.ts";
import { eventsAfterWithHead, logHead } from "./audit-events.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { holdsNothing } from "./stored-skills.ts";
import { joinTeam, leaveTeam, newTeam } from "./teams.ts";

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
// The team dimension (GRA-1844): the same name shared with the company
// and with two of the asker's teams, each its own audience, decided and
// reconciled apart. Then, of each audience, all of the above, and:
//
// - no decision of a team share is made after its asker left the team,
//   and no admin is shown a waiting share of someone not in its team;
// - a member outside the teams is given the company's skill of the name
//   (when live) and never a team's; a member of the teams is given each
//   team's live one in its place.
//
// Deterministic: a fixed sweep (each of approving, asking again, retiring
// and deleting held before each of its steps while one of those or a
// removal runs; each failing before, or losing the reply after, each of
// its steps), each finding of the round as its own sequence, and seeded
// random sequences of two holds; and the same for the team operations,
// with the asker leaving the team at every step.

const idp = mockIdp();

/** Every sequence is short; the whole sweep is what takes time. */
const sweepTime = { timeout: 600_000 };

/** The operations on the company's shares, and on the person and their skill. */
type CompanyOp =
  | "approve"
  | "askAgain"
  | "askOld"
  | "otherAsk"
  | "retire"
  | "delete"
  | "remove"
  | "erase"
  | "decline";

/** The operations on the teams' shares: a sequence with one sets the teams up. */
type TeamOp =
  | "approveTeam"
  | "askTeam"
  | "retireTeam"
  | "leave"
  | "askTeamB"
  | "approveTeamB"
  | "rejoin";

type Op = CompanyOp | TeamOp;

const teamOps: ReadonlySet<string> = new Set<TeamOp>([
  "approveTeam",
  "askTeam",
  "retireTeam",
  "leave",
  "askTeamB",
  "approveTeamB",
  "rejoin",
]);

/** Whether `op` is one of the teams' operations. */
const isTeamOp = (op: Op): op is TeamOp => teamOps.has(op);

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

let people:
  | { first: Person; second: Person; member: Person; mate: Person }
  | undefined;

/**
 * The admins, the member (in no team) and the team-mate (in every team of
 * every world) every sequence of a test shares.
 */
const shared = async () => {
  people ??= {
    first: await personOf("admin"),
    second: await personOf("admin"),
    member: await personOf("user"),
    mate: await personOf("user"),
  };
  return people;
};

/** The two teams of a world: the asker and the team-mate are in both. */
interface Teams {
  a: string;
  b: string;
}

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
  /** The team-mate, in both teams throughout. */
  mate: Person;
  /** The teams, when the sequence has team operations. */
  teams: Teams | undefined;
  /** The last share asked of each team, as a card an admin may still click. */
  lastTeamShare: Map<string, string>;
  /**
   * Once the asker left team A: the decisions of their shares with it
   * there were then. Any other is one decided after they left.
   */
  decidedBeforeLeaving: Set<string> | undefined;
  /**
   * Once the asker rejoined team A: the decisions of their shares with it
   * there were then. One here but not before leaving was decided while
   * they were out.
   */
  decidedBeforeRejoining: Set<string> | undefined;
  /** What an operation found as it ran: a refused ask that changed something. */
  refusals: string[];
}

/** The audience a share or decision of team `team` is stored as. */
const teamKey = (team: string): string => `team:${team}`;

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

/**
 * The newest share of the name with `audience` (stored) waiting now, as
 * the admin's card shows it; else the last one asked of it.
 */
const cardOf = async (w: World, audience = "company"): Promise<string> => {
  const [waiting] = await drizzle(env.DB)
    .select({ id: skillShares.id })
    .from(skillShares)
    .where(
      and(
        eq(skillShares.name, w.name),
        eq(skillShares.audience, audience),
        eq(skillShares.status, "pending")
      )
    )
    .orderBy(desc(skillShares.requestedAt))
    .limit(1);
  const last =
    audience === "company" ? w.lastShare : w.lastTeamShare.get(audience);
  return waiting?.id ?? last ?? crypto.randomUUID();
};

/** World `w`'s teams: refused when the sequence set none up. */
const teamsOf = (w: World): Teams => {
  if (w.teams === undefined) {
    throw new Error("A team operation in a world without teams");
  }
  return w.teams;
};

/** Saves a new text of the asker's skill, outside any steps. */
const saveNew = async (w: World): Promise<number> => {
  w.saves += 1;
  const text = textOf(w.name, `${w.saves}`);
  w.texts.add(text);
  const saved = await saveOwnSkill(env, w.asker.ident, text);
  return saved.version;
};

/** The asker's shares with team `team` that wait now, by ID. */
const waitingWith = async (w: World, team: string): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .select({ id: skillShares.id })
    .from(skillShares)
    .where(
      and(
        eq(skillShares.requestedBy, w.asker.userId),
        eq(skillShares.name, w.name),
        eq(skillShares.audience, teamKey(team)),
        eq(skillShares.status, "pending")
      )
    );
  return rows.map(({ id }) => id);
};

/**
 * Asks again to share the asker's skill with team `team`, at a new
 * version. Refused (nothing new waits), it must have changed nothing: the
 * share that waited still does.
 */
const askTeam = async (w: World, team: string, e: Env): Promise<void> => {
  const version = await saveNew(w);
  const before = await waitingWith(w, team);
  try {
    const asked = await shareOwnSkill(e, w.asker.ident, w.name, version, {
      team,
    });
    w.lastTeamShare.set(teamKey(team), asked.id);
  } catch (error) {
    // Refused when nothing new waits: then nothing may have gone either.
    // (A new one that waits is an ask that landed and lost its reply.)
    const after = await waitingWith(w, team);
    const written = after.some((id) => !before.includes(id));
    if (!written && before.some((id) => !after.includes(id))) {
      w.refusals.push("a refused ask took away the share that waited");
    }
    throw error;
  }
};

/** The decisions of the asker's shares with `team` there are now, by ID. */
const askersDecisions = async (
  w: World,
  team: string
): Promise<Set<string>> => {
  const decided = await drizzle(env.DB)
    .select({ id: skillDecisions.id })
    .from(skillDecisions)
    .innerJoin(skillShares, eq(skillShares.id, skillDecisions.shareId))
    .where(
      and(
        eq(skillDecisions.audience, teamKey(team)),
        eq(skillShares.requestedBy, w.asker.userId)
      )
    );
  return new Set(decided.map(({ id }) => id));
};

/**
 * The asker leaves team A, and the decisions of their shares with it made
 * by then are noted: nothing else runs meanwhile (a hold waits for its
 * operations), so any other found later was decided after they left.
 */
const leaveTeamA = async (w: World): Promise<void> => {
  const team = teamsOf(w).a;
  await leaveTeam(team, w.asker.userId);
  w.decidedBeforeLeaving = await askersDecisions(w, team);
};

/** The asker joins team A again, once they left it; what was decided while they were out is noted. */
const rejoinTeamA = async (w: World): Promise<void> => {
  const team = teamsOf(w).a;
  w.decidedBeforeRejoining = await askersDecisions(w, team);
  await joinTeam(team, w.asker.userId);
};

/** Team operation `op` in `w`, on `e`: none for an operation that isn't one. */
const teamOperation = async (w: World, op: TeamOp, e: Env): Promise<void> => {
  switch (op) {
    case "approveTeam": {
      const card = await cardOf(w, teamKey(teamsOf(w).a));
      await approveShare(e, w.first.ident, card);
      return;
    }
    case "askTeam": {
      await askTeam(w, teamsOf(w).a, e);
      return;
    }
    case "retireTeam": {
      await retireSkill(e, w.second.ident, w.name, { team: teamsOf(w).a });
      return;
    }
    case "leave": {
      if (w.decidedBeforeLeaving === undefined) {
        await leaveTeamA(w);
      }
      return;
    }
    case "rejoin": {
      if (
        w.decidedBeforeLeaving !== undefined &&
        w.decidedBeforeRejoining === undefined
      ) {
        await rejoinTeamA(w);
      }
      return;
    }
    case "askTeamB": {
      await askTeam(w, teamsOf(w).b, e);
      return;
    }
    case "approveTeamB": {
      const card = await cardOf(w, teamKey(teamsOf(w).b));
      await approveShare(e, w.first.ident, card);
      return;
    }
    default: {
      throw new Error("Not a team operation");
    }
  }
};

/** Operation `op` in `w`, on `e`. */
const operation = async (w: World, op: Op, e: Env): Promise<void> => {
  if (isTeamOp(op)) {
    await teamOperation(w, op, e);
    return;
  }
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
const worldOf = async (withTeams = false): Promise<World> => {
  const { first, second, member, mate } = await shared();
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
    mate,
    teams: undefined,
    lastTeamShare: new Map(),
    decidedBeforeLeaving: undefined,
    decidedBeforeRejoining: undefined,
    refusals: [],
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
  if (withTeams) {
    // Team A: its first text added, the next one waiting, as the
    // company's; team B: nothing yet.
    const a = await newTeam(w.asker.userId, mate.userId);
    const b = await newTeam(w.asker.userId, mate.userId);
    w.teams = { a, b };
    const forA = await shareOwnSkill(env, w.asker.ident, w.name, 1, {
      team: a,
    });
    await approveShare(env, first.ident, forA.id);
    const waitingForA = await shareOwnSkill(env, w.asker.ident, w.name, 2, {
      team: a,
    });
    w.lastTeamShare.set(teamKey(a), waitingForA.id);
  }
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

/** One audience of a world: how it is stored, named and read. */
interface Audience {
  /** As shares and decisions store it. */
  key: string;
  audience: SkillAudience;
  /** The skill members of it read. */
  skill: Skill;
  /** Someone in it throughout, who reads it. */
  reader: Person;
  /** How a retirement's events name it. */
  target: string;
}

/** The audiences of `w`: the company, and its teams when it has them. */
const audiencesOf = (w: World): Audience[] => [
  {
    key: "company",
    audience: { kind: "company" },
    skill: { scope: "company", name: w.name },
    reader: w.member,
    target: w.name,
  },
  ...(w.teams === undefined ? [] : [w.teams.a, w.teams.b]).map(
    (team): Audience => ({
      key: teamKey(team),
      audience: { kind: "team", team },
      skill: { scope: "team", team, name: w.name },
      reader: w.mate,
      target: `${team}:${w.name}`,
    })
  ),
];

/** What `audience`'s reader reads of its skill of `w.name`: its text, or null. */
const liveTextOf = async (a: Audience): Promise<string | null> => {
  const read = await readCurrentSkillAs(env, a.reader.userId, a.skill);
  return read?.text ?? null;
};

/** That the Brain follows the latest decision of `a`, and it landed. */
const liveViolations = async (
  a: Audience,
  decisions: readonly DecisionRow[]
): Promise<string[]> => {
  const latest = decisions.at(-1);
  const expected =
    latest === undefined || latest.shareId === null ? null : latest.text;
  const live = await liveTextOf(a);
  return [
    ...(live === expected
      ? []
      : [
          `${a.key}: live ${tagOf(live)}, the latest decision says ${tagOf(expected)}`,
        ]),
    ...(latest === undefined || latest.outcome === "landed"
      ? []
      : [`${a.key}: the latest decision is ${latest.outcome ?? "on its way"}`]),
  ];
};

/**
 * That `decision` of `a` decided a share open when decided, of its own
 * audience, of a skill not deleted, of an asker still in its team.
 */
const shareViolations = (
  w: World,
  a: Audience,
  decision: DecisionRow,
  share: ShareRow | undefined
): string[] => {
  const found: string[] = [];
  if (share === undefined ? !w.erased : share.status !== "approved") {
    found.push(`${a.key}: decision ${decision.seq} is of a closed share`);
  }
  if (share !== undefined && share.audience !== a.key) {
    found.push(
      `${a.key}: decision ${decision.seq} is of another audience's share`
    );
  }
  const afterDeletion =
    w.deletedAt !== undefined && decision.decidedAt.getTime() > w.deletedAt;
  const askers = share?.requestedBy === w.asker.userId;
  if (afterDeletion && askers && w.texts.has(decision.text)) {
    found.push(
      `${a.key}: decision ${decision.seq} decided a deleted skill's text`
    );
  }
  const left = w.decidedBeforeLeaving;
  const back = w.decidedBeforeRejoining;
  const ofTeamA = w.teams !== undefined && a.key === teamKey(w.teams.a);
  // Decided after they left, and before they were back if they came back.
  const whileOut =
    left !== undefined &&
    !left.has(decision.id) &&
    (back === undefined || back.has(decision.id));
  if (ofTeamA && askers && whileOut) {
    found.push(
      `${a.key}: decision ${decision.seq} decided after its asker left the team`
    );
  }
  return found;
};

/** That `decision` of `a`'s outcome is the store's, said once, of a share open when decided. */
const decisionViolations = async (
  w: World,
  a: Audience,
  decision: DecisionRow,
  shares: readonly ShareRow[],
  events: readonly AuditEvent[]
): Promise<string[]> => {
  const found: string[] = [];
  const made = await sharedChangeVersion(env, {
    audience: a.audience,
    name: w.name,
    change: `decision:${decision.id}`,
  });
  const landedAs = decision.outcome === "landed" ? decision.version : null;
  if (decision.outcome === null || made !== landedAs) {
    found.push(
      `${a.key}: decision ${decision.seq} says ${decision.outcome ?? "nothing"} ${landedAs}, the store made ${made}`
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
      `${a.key}: decision ${decision.seq}: ${approved.length} approved, ${added.length} added, ${superseded.length} superseded`
    );
  }
  if (added.some(({ detail }) => detail?.version !== decision.version)) {
    found.push(
      `${a.key}: decision ${decision.seq}'s added event says another version`
    );
  }
  const share = shares.find(({ id }) => id === shareId);
  return [...found, ...shareViolations(w, a, decision, share)];
};

/** That each retirement of `a` has its decision event and one outcome. */
const retirementViolations = (
  a: Audience,
  decisions: readonly DecisionRow[],
  events: readonly AuditEvent[]
): string[] => {
  const retirements = decisions.filter(({ shareId }) => shareId === null);
  const of = (action: string) => countOf(events, action, a.target).length;
  const outcomes = of("skill.retire_done") + of("skill.retire_superseded");
  return of("skill.retired") === retirements.length &&
    outcomes === retirements.length
    ? []
    : [
        `${a.key}: ${retirements.length} retirements, ${of("skill.retired")} retired events, ${outcomes} outcomes`,
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

/** What `reader`'s chat is given of the name: each skill as scope (and team). */
const givenOf = async (w: World, reader: Person): Promise<string[]> => {
  const given = await skillsFor(
    env,
    actingFor({ type: "agent", agentId: `agent-${unique()}` }, reader.userId),
    "teams",
    holdsNothing
  );
  return given
    .filter(({ name }) => name === w.name)
    .map((skill) =>
      skill.scope === "team" ? `team ${skill.team}` : skill.scope
    );
};

/**
 * That the teams' skills reach their members alone, in place of the
 * company's of the name, and that no admin is shown a waiting share of
 * someone not in its team.
 */
const teamViolations = async (
  w: World,
  live: ReadonlyMap<string, boolean>
): Promise<string[]> => {
  if (w.teams === undefined) {
    return [];
  }
  const found: string[] = [];
  const { a, b } = w.teams;
  const company = live.get("company") === true ? ["company"] : [];
  const teamsLive = [a, b].filter((team) => live.get(teamKey(team)) === true);
  const outsider = await givenOf(w, w.member);
  if (outsider.join(",") !== company.join(",")) {
    found.push(
      `a member in no team is given ${outsider.join(",") || "nothing"}, not ${company.join(",") || "nothing"}`
    );
  }
  const mate = await givenOf(w, w.mate);
  const mateExpected =
    teamsLive.length > 0
      ? teamsLive.map((team) => `team ${team}`).toSorted()
      : company;
  if (mate.toSorted().join(",") !== mateExpected.join(",")) {
    found.push(
      `a team-mate is given ${mate.join(",") || "nothing"}, not ${mateExpected.join(",") || "nothing"}`
    );
  }
  if (
    w.decidedBeforeLeaving !== undefined &&
    w.decidedBeforeRejoining === undefined
  ) {
    const shown = await waitingShares(env, w.first.ident);
    if (
      shown.some(
        (share) =>
          share.requestedBy.userId === w.asker.userId &&
          share.audience.kind === "team" &&
          share.audience.team.id === a
      )
    ) {
      found.push("an admin is shown a share of someone who left its team");
    }
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
  const shares = await db
    .select()
    .from(skillShares)
    .where(eq(skillShares.name, w.name));
  const { events } = await eventsAfterWithHead(head);
  const found: string[] = [];
  const live = new Map<string, boolean>();
  for (const a of audiencesOf(w)) {
    // oxlint-disable-next-line no-await-in-loop -- an audience at a time
    const decisions = await db
      .select()
      .from(skillDecisions)
      .where(
        and(eq(skillDecisions.name, w.name), eq(skillDecisions.audience, a.key))
      )
      .orderBy(asc(skillDecisions.seq));
    live.set(a.key, decisions.at(-1)?.shareId !== null && decisions.length > 0);
    // oxlint-disable-next-line no-await-in-loop -- an audience at a time
    const each = await Promise.all(
      decisions.map(
        async (decision) =>
          await decisionViolations(w, a, decision, shares, events)
      )
    );
    found.push(
      // oxlint-disable-next-line no-await-in-loop -- an audience at a time
      ...(await liveViolations(a, decisions)),
      ...each.flat(),
      ...retirementViolations(a, decisions, events)
    );
  }
  return [
    ...found,
    ...(await personalViolations(w, shares, events)),
    ...(await teamViolations(w, live)),
    ...w.refusals,
  ];
};

/** Runs `s` in a new world: its violations, described. */
const runSequence = async (s: Sequence): Promise<string[]> => {
  const head = await logHead();
  const w = await worldOf(s.ops.some((op) => teamOps.has(op)));
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
  const w = await worldOf(teamOps.has(op));
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

/**
 * The team sweep: the asker leaving the team held inside each step of
 * each team operation and of approving for the company; and, inside each
 * step of a team's decision, a decision of the same name for the company,
 * a newer one for the team, and another team's ask and approval.
 */
const teamSweep: readonly { outer: Op; inner: readonly Op[] }[] = [
  ...(["approveTeam", "askTeam", "retireTeam", "approve"] as const).map(
    (outer) => ({ outer, inner: ["leave"] as const })
  ),
  ...(["approveTeam", "retireTeam"] as const).flatMap((outer) =>
    (
      [
        ["approve"],
        ["askTeam", "approveTeam"],
        ["askTeamB", "approveTeamB"],
      ] as const
    ).map((inner) => ({ outer, inner }))
  ),
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

  it(
    "holds each team operation held at each step while the asker leaves the team, or a decision of the same name is made for the company or another team",
    sweepTime,
    async () => {
      const violations: string[] = [];
      let runs = 0;
      const steps = new Map<Op, number>();
      for (const { outer, inner } of teamSweep) {
        // oxlint-disable-next-line no-await-in-loop -- a world at a time
        const of = steps.get(outer) ?? (await stepsOf(outer));
        steps.set(outer, of);
        for (let step = 1; step <= of; step += 1) {
          // oxlint-disable-next-line no-await-in-loop -- a world at a time
          const found = await runSequence({
            ops: [outer, ...inner],
            placements: [
              {
                op: 0,
                step,
                kind: "hold",
                inner: inner.map((_, at) => at + 1),
              },
            ],
          });
          violations.push(...found);
          runs += 1;
        }
      }
      expect({ violations, ran: runs > 0 }).toStrictEqual({
        violations: [],
        ran: true,
      });
    }
  );

  it(
    "holds when each team operation fails before, or loses the reply after, each step",
    sweepTime,
    async () => {
      const violations: string[] = [];
      for (const outer of ["approveTeam", "askTeam", "retireTeam"] as const) {
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
    "holds asking again after leaving the team, refused, then rejoining: the first ask waits again, and is decided",
    sweepTime,
    async () => {
      const violations: string[] = [];
      // As it happens one after another, then with the leave inside each
      // step of the ask.
      const sequences: Sequence[] = [
        { ops: ["leave", "askTeam", "rejoin", "approveTeam"], placements: [] },
      ];
      const steps = await stepsOf("askTeam");
      for (let step = 1; step <= steps; step += 1) {
        sequences.push({
          ops: ["askTeam", "leave", "rejoin", "approveTeam"],
          placements: [{ op: 0, step, kind: "hold", inner: [1] }],
        });
      }
      for (const s of sequences) {
        // oxlint-disable-next-line no-await-in-loop -- a world at a time
        violations.push(...(await runSequence(s)));
      }
      expect({ violations, ran: sequences.length > 1 }).toStrictEqual({
        violations: [],
        ran: true,
      });
    }
  );
});
