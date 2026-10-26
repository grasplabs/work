import type { ChannelSigningKey } from "@grasp-os/shared/channel-keys";
import { sharedRun } from "@grasp-os/shared/shared-runs";
import type { SharedRun } from "@grasp-os/shared/shared-runs";

// The keys a channel's provider signs its webhook calls with (Teams'
// activities, Gmail's pushes), as one isolate holds them: fetched through
// connect, kept an hour, and fetched again sooner for a key id they don't
// have, at most once a minute. Every request the isolate serves checks
// against them, so a wrong set lets forged messages in or keeps genuine
// ones out. From the threat model (GRA-1078):
//
// - A fetch whose request was cancelled never settles: the requests asking
//   meanwhile share it only as long as a fetch may take (`keysFetchMs`,
//   `sharedRun`), and the next to need the keys then fetches anew. One
//   replacement per stuck fetch, however many wait on it.
// - A fetch replaced that way may still settle, after its replacement,
//   with older keys: only the fetch begun last keeps its set, so a late one
//   never brings back a key the provider removed or drops one it added.
// - Made-up key ids can't have every request ask connect: fetches start at
//   most once a minute for a key id the set lacks, a failed fetch
//   included, and requests that come while one is under way share it.
// - A request that waits on another's fetch goes on in its own context
//   (`sharedRun`), never in the request that started the fetch.
// - A failed fetch keeps nothing: the set held before stays, and the
//   requests waiting on it are refused.

/** One fetch's keys, by key id, and when it settled. */
interface KeySet {
  keys: Map<string, ChannelSigningKey>;
  at: number;
}

/** How long fetched keys are used before they are fetched again. */
const keysMaxAgeMs = 60 * 60 * 1000;

/** How often a key id not among the keys may have them fetched again. */
const refreshIntervalMs = 60 * 1000;

/**
 * The longest a fetch of the keys through connect may take before the
 * requests waiting on it take it for abandoned, and the next one fetches
 * anew.
 */
const keysFetchMs = 10_000;

/** The one key a channel's fetches share under (`sharedRun`). */
const fetchKey = "keys";

/**
 * A channel's keys as an isolate holds them: the set it keeps, when it last
 * started a fetch, the fetch under way, if one is, and how many fetches
 * began, of which only the latest keeps its set.
 */
export interface ChannelKeys {
  set?: KeySet;
  lastFetch: number;
  readonly fetches: Map<string, SharedRun<KeySet>>;
  begun: number;
}

/** A channel's keys, not yet fetched. */
export const channelKeys = (): ChannelKeys => ({
  lastFetch: Number.NEGATIVE_INFINITY,
  fetches: new Map(),
  begun: 0,
});

/**
 * The keys `fetchKeys` answers, as this request gets them: from the fetch
 * under way, or one it starts.
 */
const fetched = async (
  fetchKeys: () => Promise<readonly ChannelSigningKey[]>,
  keys: ChannelKeys
): Promise<KeySet> =>
  await sharedRun(keys.fetches, fetchKey, keysFetchMs, async () => {
    keys.lastFetch = Date.now();
    keys.begun += 1;
    const number = keys.begun;
    const answer = await fetchKeys();
    const set = {
      keys: new Map(answer.map((key) => [key.kid, key])),
      at: Date.now(),
    };
    if (number === keys.begun) {
      keys.set = set;
    }
    return set;
  });

/**
 * The published key `kid` names. The keys are fetched when they are older
 * than an hour, or when `kid` isn't among them; fetches start at least a
 * minute apart whatever the keys' state, a failed one included, so an
 * outage or made-up key ids can't have every request ask connect again. A
 * request arriving while a fetch is under way shares that fetch.
 */
export const keyFor = async (
  fetchKeys: () => Promise<readonly ChannelSigningKey[]>,
  keys: ChannelKeys,
  kid: string
): Promise<ChannelSigningKey | undefined> => {
  const now = Date.now();
  const { set } = keys;
  const fresh = set !== undefined && now - set.at < keysMaxAgeMs;
  const known = fresh ? set.keys.get(kid) : undefined;
  if (known !== undefined) {
    return known;
  }
  if (keys.fetches.size === 0 && now - keys.lastFetch < refreshIntervalMs) {
    return undefined;
  }
  const answer = await fetched(fetchKeys, keys);
  return answer.keys.get(kid);
};
