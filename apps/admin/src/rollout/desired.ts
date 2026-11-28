/**
 * What every client should run, and which moves of a channel are allowed:
 * pure functions over the stored desired state, so the rollout pass
 * (src/rollout/scheduler.ts, src/rollout/plan.ts), the actions
 * (src/rollout/channels.ts) and the pages decide alike.
 *
 * The desired state is small: each channel's release, and each client's
 * channel and optional pin. A client's target is its pin, otherwise its
 * channel's release. What's still to deploy is whatever runs something
 * other than its target; a channel's rollout (`rollouts`) only orders and
 * halts it.
 */
import "@tanstack/react-start/server-only";
import type { Channel } from "./channel-ids.ts";

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
export const previousChannel: Readonly<Record<Channel, Channel | null>> = {
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
  const previous = previousChannel[channel];
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

/** A client's last deploy, as the rollout pass recorded it. */
export interface LastDeploy {
  releaseId: string;
  status: "deploying" | "done" | "failed";
  error: string | null;
  /** The rollout it deployed for; null for one outside any rollout. */
  rolloutId: string | null;
}

/** What the rollout pass knows of one active client. */
export interface ClientFacts {
  id: string;
  channel: Channel;
  pinnedReleaseId: string | null;
  /** The release every one of its Workers runs; null when they don't run one. */
  running: string | null;
  /** Whether it was given shared secrets other than Secrets Store's now. */
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
 * runs its target with Secrets Store's shared secrets; otherwise waiting
 * for the rollout pass. With no target yet, `no_release`.
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

/** Shared-secret fingerprints, by Worker, then name. */
export type SharedByWorker = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/**
 * Whether a client's shared secrets are behind Secrets Store's: what its
 * operation last delivered (`delivered`) differs from what a deploy would
 * deliver now (`desired`, the store's fingerprints, read live) on any
 * Worker: another fingerprint, a name it lacks, or one the store no
 * longer has. A deploy delivers the store's values as they are, so one
 * that succeeds settles the client. Nothing is behind while the store
 * can't be read (`desired` null): no deploy could run then either.
 */
export const isSecretsBehind = (
  delivered: SharedByWorker,
  desired: SharedByWorker | null
): boolean => {
  if (desired === null) {
    return false;
  }
  const workers = new Set([...Object.keys(desired), ...Object.keys(delivered)]);
  return [...workers].some((worker) => {
    const want = desired[worker] ?? {};
    const got = delivered[worker] ?? {};
    const names = new Set([...Object.keys(want), ...Object.keys(got)]);
    return [...names].some((name) => want[name] !== got[name]);
  });
};
