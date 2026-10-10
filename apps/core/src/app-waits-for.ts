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

/** What `waitsOn` goes by. */
export interface WaitsFor {
  /** The App whose queue the call is about to wait in. */
  self: AppId;
  /** The turns the call's chain holds (`CallPath.holding`). */
  holding: readonly Hold[];
  /** Whether `call` holds `self`'s turn now. */
  holds: (call: string) => boolean;
  /**
   * For each call waiting for `hold.app`, the turns its chain holds; none
   * at all unless `hold.call` still holds that App's turn
   * (`App.waitingHolds`). May reject or time out: that App is passed over.
   */
  ask: (hold: Hold) => Promise<Hold[][]>;
  /** How many Apps to ask at most. */
  limit: number;
}

const keyOf = ({ app, call }: Hold): string => `${app} ${call}`;

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
 *
 * A turn still running counts as waiting for every call it left waiting,
 * awaited or not: one that raced an export call against a timeout of its
 * own, and went on without it, keeps its hold current. So a call that
 * would close a cycle back through it is refused until that turn ends,
 * though the turn would have ended without that call.
 *
 * It asks at most `limit` Apps, and passes over one that can't answer:
 * either way the call only waits, as it would have. So a cycle is always
 * found when at most `limit` Apps wait, directly or through others, for
 * the call's chain; past that, it may not be. In a round wider than
 * what's left, holds from chains that share an App already asked go
 * first: they go on along a chain the walk is already on.
 */
export const waitsOn = async ({
  self,
  holding,
  holds,
  ask,
  limit,
}: WaitsFor): Promise<boolean> => {
  const seen = new Set(holding.map(keyOf));
  const asked = new Set<AppId>();
  let left = limit;
  // A round cut to what is left asks nothing once nothing is: the walk
  // ends there.
  let asking = holding.filter(({ app }) => app !== self).slice(0, left);
  while (asking.length > 0) {
    const round = asking;
    left -= round.length;
    for (const { app } of round) {
      asked.add(app);
    }
    // oxlint-disable-next-line no-await-in-loop -- each round asks the Apps the last one found
    const answers = await Promise.allSettled(
      round.map(async (hold) => await ask(hold))
    );
    const onChain: Hold[] = [];
    const elsewhere: Hold[] = [];
    for (const answer of answers) {
      const tags = answer.status === "fulfilled" ? answer.value : [];
      for (const tag of tags) {
        if (tag.some(({ app, call }) => app === self && holds(call))) {
          return true;
        }
        const found = tag.some(({ app }) => asked.has(app))
          ? onChain
          : elsewhere;
        for (const hold of tag) {
          if (hold.app !== self && !seen.has(keyOf(hold))) {
            seen.add(keyOf(hold));
            found.push(hold);
          }
        }
      }
    }
    asking = [...onChain, ...elsewhere].slice(0, left);
  }
  return false;
};
