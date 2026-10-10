import type { AppId } from "@grasp-os/shared/ids";

/**
 * One App's turn, as a chain of calls between Apps holds it: the App, and
 * an opaque ID of the call holding its turn (never its token). An App's
 * host can say whether that call still holds it, so a hold another App
 * passes on is checked where it is, never taken on trust.
 */
export interface Hold {
  app: AppId;
  call: string;
}

/**
 * What an App answers when asked about some of its turns: the one of them
 * that holds it now, and, for each call waiting for it, the turns that
 * call's chain holds (`App.waitingHolds`).
 */
export interface Held {
  holder: string;
  waiting: Hold[][];
}

/** What `waitsOn` goes by. */
export interface WaitsFor {
  /** The App whose queue the call is about to wait in. */
  self: AppId;
  /** The turns the call's chain holds (`CallPath.holding`). */
  holding: readonly Hold[];
  /** Whether `call` holds `self`'s turn now. */
  holds: (call: string) => boolean;
  /**
   * What `app` answers while one of `calls` holds its turn, or nothing
   * (`App.waitingHolds`). May reject or time out: that App is passed over.
   */
  ask: (app: AppId, calls: readonly string[]) => Promise<Held | undefined>;
  /** How many Apps to ask at most. */
  limit: number;
  /** Aborts once the call no longer waits: the walk asks nothing more. */
  signal: AbortSignal;
}

const keyOf = ({ app, call }: Hold): string => `${app} ${call}`;

const sameHold = (one: Hold, other: Hold): boolean =>
  one.app === other.app && one.call === other.call;

/** One step of a cycle found: `asker`'s queue holds a call holding `expects`. */
interface Edge {
  asker: Hold;
  expects: Hold;
}

/**
 * The steps back from `last`, found in `from`'s queue, to the call's own
 * turns, by where the walk found each hold (`foundIn`).
 */
const stepsBack = (
  foundIn: ReadonlyMap<string, Hold | undefined>,
  from: Hold,
  last: Hold
): Edge[] => {
  const edges: Edge[] = [];
  let step: Edge | undefined = { asker: from, expects: last };
  while (step !== undefined) {
    edges.push(step);
    const above = foundIn.get(keyOf(step.asker));
    step =
      above === undefined ? undefined : { asker: above, expects: step.asker };
  }
  return edges;
};

/**
 * Whether every step of a cycle found still holds, all asked at once,
 * and `last`, `self`'s turn, still holds `self`.
 */
const stillWaits = async (
  { ask, holds, signal }: WaitsFor,
  edges: readonly Edge[],
  last: Hold
): Promise<boolean> => {
  const answers = await Promise.allSettled(
    edges.map(async ({ asker }) => await ask(asker.app, [asker.call]))
  );
  if (signal.aborted || !holds(last.call)) {
    return false;
  }
  return edges.every(({ asker, expects }, at) => {
    const answer = answers[at];
    const held = answer?.status === "fulfilled" ? answer.value : undefined;
    return (
      held?.holder === asker.call &&
      held.waiting.some((tag) => tag.some((hold) => sameHold(hold, expects)))
    );
  });
};

/**
 * The Apps to ask this round, each about all its turns `pending` found:
 * none whose holder the walk knows already, and an App not asked before
 * only while fewer than `limit` were.
 */
const roundOf = (
  pending: readonly Hold[],
  asked: ReadonlySet<AppId>,
  known: ReadonlySet<AppId>,
  limit: number
): [AppId, string[]][] => {
  const calls = new Map<AppId, string[]>();
  let added = 0;
  for (const { app, call } of pending) {
    const turns = calls.get(app);
    if (turns !== undefined) {
      turns.push(call);
    } else if (asked.has(app) && !known.has(app)) {
      calls.set(app, [call]);
    } else if (!asked.has(app) && asked.size + added < limit) {
      added += 1;
      calls.set(app, [call]);
    }
  }
  return [...calls];
};

/**
 * Whether `self`'s turn waits, through calls waiting in other Apps'
 * queues, on one of `holding`: if so, a call holding those turns would
 * wait for an App that waits for it, each in the other's queue until a
 * deadline ended one.
 *
 * Each App is its own object, so no one sees every queue: each knows
 * only who waits in its own. The walk goes back from `holding`, round by
 * round: who waits for those turns, then who waits for theirs; `self`,
 * held by the call that holds it now, closes the cycle. Every hold is
 * checked by the App it names (`ask`), and `self`'s here (`holds`), so a
 * hold left behind by a call that has ended (a call its code didn't
 * await, a call of a `Promise.all` that failed fast) counts for nothing.
 * Each App is asked about all the turns of it a round found at once, and
 * once one of them holds it, about none again: a busy App's many turns
 * that have ended cost one ask, not one each.
 *
 * Rounds take time, and a turn found holding its App in one may have
 * ended by the last. So a cycle found is asked about once more, every
 * step of it at once, and counts only if each still holds; otherwise the
 * call waits.
 *
 * A turn still running counts as waiting for every call it left waiting,
 * awaited or not: one that raced an export call against a timeout of its
 * own, and went on without it, keeps its hold current. So a call that
 * would close a cycle back through it is refused until that turn ends,
 * though the turn would have ended without that call.
 *
 * It asks at most `limit` Apps, passes over one that can't answer, and
 * stops once the call no longer waits (`signal`): either way the call
 * only waits, as it would have. So a cycle is always found when at most
 * `limit` Apps wait, directly or through others, for the call's chain;
 * past that, it may not be. In a round wider than what's left, holds from
 * chains that share an App already asked go first: they go on along a
 * chain the walk is already on.
 */
export const waitsOn = async (walk: WaitsFor): Promise<boolean> => {
  const { self, holding, holds, ask, limit, signal } = walk;
  /** For each hold found, the turn whose queue it was found in. */
  const foundIn = new Map<string, Hold | undefined>(
    holding.map((hold) => [keyOf(hold), undefined])
  );
  /** Apps asked, and those whose holder the walk has found. */
  const asked = new Set<AppId>();
  const known = new Set<AppId>();
  let pending = holding.filter(({ app }) => app !== self);
  while (pending.length > 0 && !signal.aborted) {
    const round = roundOf(pending, asked, known, limit);
    for (const [app] of round) {
      asked.add(app);
    }
    // oxlint-disable-next-line no-await-in-loop -- each round asks the Apps the last one found
    const answers = await Promise.allSettled(
      round.map(async ([app, turns]) => await ask(app, turns))
    );
    const onChain: Hold[] = [];
    const elsewhere: Hold[] = [];
    for (const [at, answer] of answers.entries()) {
      const [app, turns] = round[at] ?? [self, []];
      const held = answer.status === "fulfilled" ? answer.value : undefined;
      if (held === undefined || !turns.includes(held.holder)) {
        continue;
      }
      known.add(app);
      const from: Hold = { app, call: held.holder };
      for (const tag of held.waiting) {
        const closing = tag.find(
          (hold) => hold.app === self && holds(hold.call)
        );
        if (
          closing !== undefined &&
          // oxlint-disable-next-line no-await-in-loop -- rare: only once a cycle is found
          (await stillWaits(walk, stepsBack(foundIn, from, closing), closing))
        ) {
          return true;
        }
        const found = tag.some((hold) => asked.has(hold.app))
          ? onChain
          : elsewhere;
        for (const hold of tag) {
          if (hold.app !== self && !foundIn.has(keyOf(hold))) {
            foundIn.set(keyOf(hold), from);
            found.push(hold);
          }
        }
      }
    }
    pending = [...onChain, ...elsewhere];
  }
  return false;
};
