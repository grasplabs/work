/**
 * What every client should run, and which moves of a channel are allowed:
 * pure functions over the stored desired state, so the reconciler
 * (src/rollout/reconciler.ts), the actions (src/rollout/channels.ts) and
 * the pages decide alike.
 *
 * The stored state is small: each channel's release, and each client's
 * channel and optional pin. A client's target is its pin, otherwise its
 * channel's release. Nothing records a rollout: what's still to deploy is
 * whatever runs something other than its target.
 */
import type { Channel } from "../db/schema.ts";

/**
 * How many clients of one channel deploy at once. Cloudflare's API allows
 * about 1,200 requests per 5 minutes per token, and one deploy makes a few
 * dozen calls, so 25 at once stays well under it. To be adjusted once a
 * real deploy on staging is timed.
 */
export const parallelDeploys = 25;

/** The release each channel points at; null before one was promoted to it. */
export type ChannelReleases = Readonly<Record<Channel, string | null>>;

/** The release `client` should run: its pin, else its channel's; null for none yet. */
export const targetOf = (
  client: { channel: Channel; pinnedReleaseId: string | null },
  releases: ChannelReleases
): string | null => client.pinnedReleaseId ?? releases[client.channel];

/** A channel's release as it changed: one promotion, from the audit log. */
export interface Promotion {
  channel: Channel;
  releaseId: string;
}

/**
 * The channel a release must have been on before it may go to `channel`:
 * Edge before Beta, Beta before Stable. Edge takes each new release by
 * itself, so it has none.
 */
const before: Readonly<Record<Channel, Channel | null>> = {
  edge: null,
  beta: "edge",
  stable: "beta",
};

/** Why moving a channel to a release is refused, or null when it may. */
export type PromotionRefusal = "current" | "not_on_previous_channel";

/**
 * Whether `channel` may be set to `releaseId`, given every promotion so
 * far (`history`, any order) and the release it points at now. Forward,
 * a release goes Edge, then Beta, then Stable: to Beta only once it was
 * Edge's, to Stable only once it was Beta's. Back, a channel may return
 * to any release it had itself before: that's a rollback.
 */
export const promotionRefusal = (
  channel: Channel,
  releaseId: string,
  current: string | null,
  history: readonly Promotion[]
): PromotionRefusal | null => {
  if (releaseId === current) {
    return "current";
  }
  const had = (on: Channel) =>
    history.some(
      (promotion) =>
        promotion.channel === on && promotion.releaseId === releaseId
    );
  const previous = before[channel];
  if (had(channel) || (previous !== null && had(previous))) {
    return null;
  }
  return "not_on_previous_channel";
};

/**
 * The releases `channel` may be set to (`promotionRefusal`), in the order
 * of `releases` (newest first, as the admin lists them).
 */
export const promotableReleases = (
  channel: Channel,
  current: string | null,
  history: readonly Promotion[],
  releases: readonly string[]
): string[] =>
  releases.filter(
    (releaseId) =>
      promotionRefusal(channel, releaseId, current, history) === null
  );

/** A client's last deploy, as the reconciler recorded it. */
export interface LastDeploy {
  releaseId: string;
  status: "deploying" | "done" | "failed";
  error: string | null;
}

/** What the reconciler knows of one active client. */
export interface ClientFacts {
  id: string;
  channel: Channel;
  pinnedReleaseId: string | null;
  /** The release every one of its Workers runs; null when they don't run one. */
  running: string | null;
  /** Whether it runs shared secrets other than the ones staff rolled out. */
  secretsBehind: boolean;
  deploy: LastDeploy | null;
}

/** Where a client stands against its target. */
export type ClientState =
  | "up_to_date"
  | "deploying"
  | "waiting"
  | "failed"
  | "no_release";

/**
 * Where `client` stands: deploying while a deploy is out; failed when its
 * last deploy of its target failed (until staff retry); up to date when it
 * runs its target with the shared secrets rolled out; otherwise waiting
 * for the reconciler. With no target yet, `no_release`.
 */
export const stateOf = (
  client: ClientFacts,
  releases: ChannelReleases
): ClientState => {
  const target = targetOf(client, releases);
  if (client.deploy?.status === "deploying") {
    return "deploying";
  }
  if (target === null) {
    return "no_release";
  }
  if (
    client.deploy?.status === "failed" &&
    client.deploy.releaseId === target
  ) {
    return "failed";
  }
  if (client.running === target && !client.secretsBehind) {
    return "up_to_date";
  }
  return "waiting";
};

/** What the reconciler does on one channel at one tick. */
export interface ChannelPlan {
  /**
   * Whether a client following the channel (not pinned) failed its
   * deploy of the channel's release: no new deploy starts on it until
   * staff retry, or promote another release.
   */
  failed: boolean;
  /** The clients to start deploying now, at most `parallelDeploys` with those out. */
  start: string[];
}

/**
 * The plan for one channel's `clients` (a page of them, or all): none
 * while it failed; otherwise the clients waiting, in the order given, as
 * many as fit beside the `deploying` ones already out (a count over the
 * whole channel).
 */
export const planChannel = (
  clients: readonly ClientFacts[],
  releases: ChannelReleases,
  deploying: number,
  failed: boolean
): ChannelPlan => {
  if (failed) {
    return { failed, start: [] };
  }
  const room = Math.max(0, parallelDeploys - deploying);
  const start = clients
    .filter((client) => stateOf(client, releases) === "waiting")
    .slice(0, room)
    .map(({ id }) => id);
  return { failed, start };
};

/**
 * Whether `client`'s failure stops its channel: its last deploy failed on
 * the channel's release, and it follows the channel (no pin).
 */
export const failsChannel = (
  client: ClientFacts,
  releases: ChannelReleases
): boolean =>
  client.pinnedReleaseId === null && stateOf(client, releases) === "failed";

/**
 * Whether shared secrets as last delivered (`delivered`, by Worker then
 * name, each a keyed fingerprint) differ from the ones staff rolled out
 * (`rolledOut`, by name): any secret a Worker holds whose fingerprint
 * isn't the rolled-out one. Nothing rolled out yet: never behind.
 */
export const isSecretsBehind = (
  delivered: Readonly<Record<string, Readonly<Record<string, string>>>>,
  rolledOut: Readonly<Record<string, string>> | null
): boolean => {
  if (rolledOut === null) {
    return false;
  }
  return Object.values(delivered).some((prints) =>
    Object.entries(prints).some(
      ([name, print]) =>
        Object.hasOwn(rolledOut, name) && rolledOut[name] !== print
    )
  );
};
