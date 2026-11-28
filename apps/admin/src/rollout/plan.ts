/**
 * What the fleet's rollout pass decides (src/rollout/scheduler.ts), as
 * pure functions over what it read: whether each channel's rollout halts
 * or is done, and who starts deploying next. Nothing here reads or writes
 * anything, so the pass, its tests and the pages decide alike.
 *
 * - **Order.** A rollout takes its organizations by size, smallest first,
 *   then by id, the `late` ones last. Running rollouts take turns, one
 *   admission each, the one with fewest out first.
 * - **Slots.** At most `maxInFlight` runs are out across the fleet, every
 *   channel and every kind of deploy together, as they share one deployer
 *   token. A rollout has at most 1 + its done count out (slow start): its
 *   first organization deploys alone, and a release proves itself on a
 *   few before many deploy at once.
 * - **Budget.** One more starts only while Cloudflare's last count of the
 *   token's requests left is at least `budgetReserve` plus
 *   `callsPerRun` for each run out; none while a 429 blocks the token.
 * - **Halt.** A running rollout halts once `failuresToHalt` organizations
 *   failed on it since it started or was last resumed (resuming clears
 *   its failures), counting only organizations that still follow its
 *   channel. A platform fault (`isPlatformFault`) never counts, and its
 *   organization is tried again, until `platformFaultsToSetAside` in a
 *   row set it aside, alerted, so it holds no one up; one that failed on
 *   the release for another rollout is tried again too. Below the threshold an organization that
 *   failed on it waits for staff (`retryClient`), and the rollout goes on.
 * - **Done.** Once every organization following its channel runs the
 *   release and none of its runs is out.
 * - After the rollouts, with the slots left: deploys that bring an
 *   organization back to its target outside any rollout (shared secrets,
 *   a pin, one joining a channel whose rollout is done). They never count
 *   toward a halt.
 */
import "@tanstack/react-start/server-only";
import { channelIds } from "./channel-ids.ts";
import type { Channel } from "./channel-ids.ts";
import { stateOf, targetOf } from "./desired.ts";
import type { ChannelReleases, ClientFacts } from "./desired.ts";

/** The fleet's limits, in one place. */
export const rolloutLimits = {
  /**
   * Runs out at once across the fleet. About 30 to 35 requests each over
   * about 2 minutes, against Cloudflare's 1,200 per 5 minutes: 16 would
   * pass it, so the budget binds before the slots do. Each organization's
   * run writes the API's `Ratelimit` count to `api_budget` as each step
   * ends (src/rollout/api-budget.ts); until the first has, the budget
   * reads as unknown (`budgetRoom`), and slow start keeps a rollout's
   * first runs few.
   */
  maxInFlight: 16,
  /**
   * Platform faults in a row on one organization after which its rollout
   * sets it aside, alerted, until staff resume or retry it.
   */
  platformFaultsToSetAside: 3,
  /** Failures since a rollout started or was resumed that halt it. */
  failuresToHalt: 3,
  /** Requests of the token's window kept back for staff pages, drift reads and provisioning. */
  budgetReserve: 200,
  /** About how many requests one organization's run makes. */
  callsPerRun: 30,
} as const;

/**
 * When a rollout reaches an organization (`clients.rollout_group`):
 * `late` ones last. `own`, stored before, reads as `normal`.
 */
export type RolloutGroup = "own" | "normal" | "late";

/** One active organization as the pass reads it. */
export interface Organization extends ClientFacts {
  group: RolloutGroup;
  /** The people on its roster; 0 while unknown. */
  size: number;
  /**
   * How many of its deploys of the same release, for the same rollout (or
   * none), ended in a platform fault in a row right before its last.
   */
  platformFaults: number;
}

/**
 * A rollout's statuses while it's live: at most one a channel has one
 * (the partial unique index `rollouts_live_channel_idx`), and a move of
 * the channel supersedes it. Only `running` admits anyone.
 */
export const liveRolloutStatuses = ["running", "halted"] as const;

/** A channel's current rollout: its live one, else its latest done one of the channel's release. */
export interface Rollout {
  id: string;
  channel: Channel;
  releaseId: string;
  status: "running" | "halted" | "done";
}

/** The deployer token's budget, as the API's last answers left it. */
export interface Budget {
  /** Requests left in its window; null while unknown, or its window has reset since. */
  remaining: number | null;
  /** Until when a 429 blocks it; null while it doesn't. */
  blockedUntil: Date | null;
}

/** What the pass reads, every channel together. */
export interface PassFacts {
  rollouts: readonly Rollout[];
  organizations: readonly Organization[];
  releases: ChannelReleases;
  /** Runs out now across the fleet, whatever started them. */
  inFlight: number;
  budget: Budget;
  now: Date;
  /** Organizations not to start again in this pass: their start was refused. */
  skip?: ReadonlySet<string>;
}

/** One rollout's organizations, counted. */
export interface RolloutCounts {
  /** Organizations following its channel that run its release. */
  done: number;
  /** Organizations that failed on it since it started or was resumed, platform faults aside. */
  failed: number;
  /** Its runs out now. */
  inFlight: number;
  /** Organizations following its channel (active, not pinned). */
  following: number;
}

/** One organization to start a run for, and the rollout it's for (null for none). */
export interface Admission {
  clientId: string;
  releaseId: string;
  rolloutId: string | null;
}

/** What one pass does. */
export interface PassPlan {
  counts: ReadonlyMap<string, RolloutCounts>;
  /** Rollouts that halt now (`failed`). */
  halt: string[];
  done: string[];
  /** Whether a 429 blocks the token now: nothing starts. */
  blocked: boolean;
  /** In the order to start them. */
  admit: Admission[];
  /** Organizations set aside now (`isSetAside`), with the fault that did it. */
  setAside: { clientId: string; releaseId: string; code: string }[];
}

/** The platform's failure codes (`isPlatformFault`), besides Cloudflare's rate limit. */
export const platformFaultCodes = [
  "run_not_created",
  "runner_replaced",
] as const;

/** What a failure code by Cloudflare's rate limit starts with (src/deploy/errors.ts). */
export const rateLimitedPrefix = "cloudflare_429";

/**
 * Whether a deploy's failure code is the platform's, not the release's:
 * Cloudflare's rate limit, a run the engine couldn't create, or another
 * runner (a staff apply) taking the client over mid-deploy.
 */
export const isPlatformFault = (code: string | null): boolean =>
  code !== null &&
  (platformFaultCodes.some((fault) => fault === code) ||
    code.startsWith(rateLimitedPrefix));

/**
 * Whether `organization` may start a run at `now`. Always, today: the
 * one place a time an organization takes deploys in (a maintenance
 * window) would say otherwise. One that may not is passed over until it
 * may, never failed, and holds up no one.
 */
export const isAdmissible = (
  _organization: Organization,
  _now: Date
): boolean => true;

/** Whether `organization` follows `channel`: on it, and not pinned. */
const follows = (organization: Organization, channel: Channel): boolean =>
  organization.channel === channel && organization.pinnedReleaseId === null;

/**
 * Whether `organization` failed on `rollout` itself, and still follows
 * its channel: what counts toward its halt. One pinned or moved since
 * counts no more.
 */
const failedOn = (organization: Organization, rollout: Rollout): boolean =>
  follows(organization, rollout.channel) &&
  organization.deploy?.status === "failed" &&
  organization.deploy.rolloutId === rollout.id &&
  !isPlatformFault(organization.deploy.error);

/**
 * Whether `organization`'s last deploy is a platform fault that ended
 * `platformFaultsToSetAside` in a row: it isn't tried again until staff
 * resume its rollout or retry it, and holds no one up. Never a failure
 * of the release's.
 */
export const isSetAside = (organization: Organization): boolean =>
  organization.deploy?.status === "failed" &&
  isPlatformFault(organization.deploy.error) &&
  organization.platformFaults + 1 >= rolloutLimits.platformFaultsToSetAside;

/** `rollout`'s organizations, counted. */
export const countsOf = (
  rollout: Rollout,
  organizations: readonly Organization[]
): RolloutCounts => {
  let done = 0;
  let failed = 0;
  let inFlight = 0;
  let following = 0;
  for (const organization of organizations) {
    const { deploy } = organization;
    if (follows(organization, rollout.channel)) {
      following += 1;
      // On the release, and not because a deploy of it failed part way.
      const failedOnRelease =
        deploy?.status === "failed" && deploy.releaseId === rollout.releaseId;
      if (organization.running === rollout.releaseId && !failedOnRelease) {
        done += 1;
      }
    }
    if (deploy?.rolloutId === rollout.id && deploy.status === "deploying") {
      inFlight += 1;
    } else if (failedOn(organization, rollout)) {
      failed += 1;
    }
  }
  return { done, failed, inFlight, following };
};

/** Whether a running rollout with `counts` halts. */
export const isHalting = (counts: RolloutCounts): boolean =>
  counts.failed >= rolloutLimits.failuresToHalt;

/** Whether a rollout with `counts` is done: every organization following its channel runs its release, and none of its runs is out. */
export const isRolloutDone = (counts: RolloutCounts): boolean =>
  counts.inFlight === 0 && counts.done === counts.following;

/** Smallest first, then by id. */
const bySize = (a: Organization, b: Organization): number => {
  if (a.size !== b.size) {
    return a.size - b.size;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
};

/** Late ones last; each part smallest first, then by id. */
const byOrder = (a: Organization, b: Organization): number =>
  Number(a.group === "late") - Number(b.group === "late") || bySize(a, b);

/**
 * Whether `organization` waits for a deploy and may start one in this
 * pass, at `now`: one whose last deploy failed for the platform's fault
 * is tried again.
 */
const isWaiting = (
  organization: Organization,
  releases: ChannelReleases,
  skip: ReadonlySet<string>,
  now: Date
): boolean => {
  const state = stateOf(organization, releases);
  return (
    !skip.has(organization.id) &&
    (state === "waiting" ||
      (state === "failed" &&
        isPlatformFault(organization.deploy?.error ?? null) &&
        !isSetAside(organization))) &&
    isAdmissible(organization, now)
  );
};

/**
 * `rollout`'s organizations to start at `now`, in order: those following
 * its channel that run another release, none of their runs out, and that
 * didn't fail on it themselves.
 */
const queueOf = (
  rollout: Rollout,
  organizations: readonly Organization[],
  skip: ReadonlySet<string>,
  now: Date
): Organization[] =>
  organizations
    .filter(
      (organization) =>
        follows(organization, rollout.channel) &&
        organization.running !== rollout.releaseId &&
        organization.deploy?.status !== "deploying" &&
        !failedOn(organization, rollout) &&
        !isSetAside(organization) &&
        !skip.has(organization.id) &&
        isAdmissible(organization, now)
    )
    .toSorted(byOrder);

/**
 * Whether `organization`, waiting, may deploy outside a rollout: pinned,
 * on its target already (only its shared secrets behind), or following
 * a channel whose rollout is done. One whose channel's rollout runs or is
 * halted waits for it, and so does one whose channel has no rollout yet.
 */
const isOutsideRollouts = (
  organization: Organization,
  releases: ChannelReleases,
  current: ReadonlyMap<Channel, Rollout>
): boolean =>
  organization.pinnedReleaseId !== null ||
  organization.running === targetOf(organization, releases) ||
  current.get(organization.channel)?.status === "done";

/** How many more runs the budget lets start beside `inFlight`; Infinity while it's unknown. */
const budgetRoom = (budget: Budget, inFlight: number): number => {
  if (budget.remaining === null) {
    return Number.POSITIVE_INFINITY;
  }
  const { budgetReserve, callsPerRun } = rolloutLimits;
  return Math.max(
    0,
    Math.floor((budget.remaining - budgetReserve) / callsPerRun) - inFlight + 1
  );
};

/** What one pass does with `facts` (`PassPlan`). */
export const planPass = (facts: PassFacts): PassPlan => {
  const { organizations, releases, budget, now } = facts;
  const skip = facts.skip ?? new Set<string>();
  const current = new Map(
    facts.rollouts.map((rollout) => [rollout.channel, rollout])
  );
  const counts = new Map<string, RolloutCounts>();
  const halt: string[] = [];
  const done: string[] = [];
  const running: Rollout[] = [];
  // Edge, Beta, then Stable: the order rollouts take turns in.
  for (const channel of channelIds) {
    const rollout = current.get(channel);
    if (rollout === undefined) {
      continue;
    }
    const counted = countsOf(rollout, organizations);
    counts.set(rollout.id, counted);
    if (rollout.status !== "running") {
      continue;
    }
    if (isHalting(counted)) {
      halt.push(rollout.id);
    } else if (isRolloutDone(counted)) {
      done.push(rollout.id);
    } else {
      running.push(rollout);
    }
  }
  const setAside = organizations.flatMap((organization) =>
    isSetAside(organization) && organization.deploy !== null
      ? [
          {
            clientId: organization.id,
            releaseId: organization.deploy.releaseId,
            code: organization.deploy.error ?? "",
          },
        ]
      : []
  );
  const blocked =
    budget.blockedUntil !== null &&
    budget.blockedUntil.getTime() > now.getTime();
  if (blocked) {
    return { counts, halt, done, blocked, admit: [], setAside };
  }
  let room = Math.min(
    rolloutLimits.maxInFlight - facts.inFlight,
    budgetRoom(budget, facts.inFlight)
  );
  const admit: Admission[] = [];
  // The rollout with fewest out first (then Edge, Beta, Stable), so one
  // slot freed at a time goes round them, not always to Edge.
  const turns = running
    .map((rollout) => {
      const { done: on = 0, inFlight = 0 } = counts.get(rollout.id) ?? {};
      return {
        rollout,
        out: inFlight,
        queue: queueOf(rollout, organizations, skip, now),
        room: 1 + on - inFlight,
      };
    })
    .toSorted((a, b) => a.out - b.out);
  // One each in turn, while any has room and someone waiting.
  let took = true;
  while (room > 0 && took) {
    took = false;
    for (const turn of turns) {
      const next = turn.room > 0 && room > 0 ? turn.queue.shift() : undefined;
      if (next !== undefined) {
        admit.push({
          clientId: next.id,
          releaseId: turn.rollout.releaseId,
          rolloutId: turn.rollout.id,
        });
        turn.room -= 1;
        room -= 1;
        took = true;
      }
    }
  }
  if (room > 0) {
    const outside = organizations
      .filter(
        (organization) =>
          isWaiting(organization, releases, skip, now) &&
          isOutsideRollouts(organization, releases, current)
      )
      .toSorted(bySize)
      .slice(0, room);
    for (const organization of outside) {
      const target = targetOf(organization, releases);
      if (target !== null) {
        admit.push({
          clientId: organization.id,
          releaseId: target,
          rolloutId: null,
        });
      }
    }
  }
  return { counts, halt, done, blocked, admit, setAside };
};
