/**
 * An alert's words and facts (src/alerts/alert.ts): what mail says of it,
 * and what Discord's card lays out (src/alerts/discord.ts), from the same
 * event, organization and time. A test alert builds its samples here too
 * (src/alerts/channels.ts), so it shows what a real one does.
 */
import "@tanstack/react-start/server-only";
import type { Channel } from "../rollout/channel-ids.ts";
import { channelWords } from "../rollout/channel-words.ts";
import type { AlertEvent } from "./alert.ts";
import type { AlertMessage } from "./senders.ts";

/** The organization an alert is about, as the admin keeps it. */
export interface AlertOrganization {
  name: string;
  channel: Channel;
  pinnedReleaseId: string | null;
}

/** One alert, for a channel that lays it out: what changed, to what, when, and where to look. */
export interface AlertFacts {
  event: AlertEvent;
  /** Null for a release, or an organization the admin doesn't hold. */
  organization: AlertOrganization | null;
  /** When it changed: when it failed, or recovered. */
  at: Date;
  /** The admin's page for it, in full; null while the admin has no hostname. */
  link: string | null;
  stage: string;
  /** A sample, sent by hand: nothing happened. */
  test: boolean;
}

/** Place `path` in this stage's admin, by its own hostname, while it has one. */
const linkOf = (env: Env, path: string): string | null =>
  env.ADMIN_HOST === "" ? null : `https://${env.ADMIN_HOST}${path}`;

/** `subject` as this stage's admin sends it: staging's say so. */
const subjectFor = (env: Env, subject: string): string =>
  env.STAGE === "production" ? subject : `[${env.STAGE}] ${subject}`;

/** The admin's page for `event`: the organization's Setup, the channels for a rollout, or the releases. */
const pathOf = (event: AlertEvent): string => {
  if ("clientId" in event) {
    return `/organizations/${encodeURIComponent(event.clientId)}/setup`;
  }
  return event.kind === "rollout_halted" || event.kind === "rollout_blocked"
    ? "/platform"
    : "/platform/releases";
};

/**
 * `event`, which changed at `at`, with the organization it's about and
 * the admin's page for it (`path`, its own unless a test's), as channels
 * lay it out.
 */
export const factsOf = (
  env: Env,
  {
    event,
    organization,
    at,
    test = false,
    path = pathOf(event),
  }: {
    event: AlertEvent;
    organization: AlertOrganization | null;
    at: Date;
    test?: boolean;
    path?: string;
  }
): AlertFacts => ({
  event,
  organization,
  at,
  link: linkOf(env, path),
  stage: env.STAGE,
  test,
});

/** What a test's mail says first. */
const testLine =
  "A test from the admin, sent by hand: no organization is affected and nothing failed. A real alert reads like this:";

/** What `event` says in mail: what happened, to which release and organization, and its code. */
const wordsOf = (
  event: AlertEvent,
  name: string | null
): { subject: string; text: string } => {
  if (event.kind === "rollout_halted") {
    const channel = channelWords[event.channel];
    return {
      subject: `${channel} rollout of ${event.releaseId} halted`,
      text: `The ${channel} rollout of release ${event.releaseId} halted: ${event.failed} organizations failed on it since it started or was last resumed (${event.done} done). Nothing new starts on ${channel} until staff resume it, or promote another release.`,
    };
  }
  if (event.kind === "rollout_blocked") {
    return {
      subject: "Rollouts paused by Cloudflare's rate limit",
      text: `Cloudflare refused the deployer token for making too many requests. No organization starts deploying until ${new Date(event.until).toISOString()}; the runs out wait it out.`,
    };
  }
  if (event.kind === "import_failed") {
    return {
      subject: `Release ${event.releaseId} didn't import`,
      text: `The admin couldn't import release ${event.releaseId} (${event.code}, attempt ${event.attempt}). It tries again by itself, waiting longer each time; it reaches no channel until it imports.`,
    };
  }
  if (event.kind === "imported") {
    return {
      subject: `Release ${event.releaseId} imported`,
      text: `Release ${event.releaseId} imported after failing before.`,
    };
  }
  const organization =
    name === null ? event.clientId : `${name} (${event.clientId})`;
  return event.kind === "deploy_failed"
    ? {
        subject: `${organization}: deploy of ${event.releaseId} failed`,
        text: `The deploy of release ${event.releaseId} to ${organization} failed (${event.code}). Retry it on its Setup once what stopped it is fixed.`,
      }
    : {
        subject: `${organization} deployed ${event.releaseId}`,
        text: `${organization} runs release ${event.releaseId} now, after a failed deploy.`,
      };
};

/**
 * `facts` as a message: what happened, to which release and organization,
 * its code, and where in the admin to look; a test's says so first.
 */
export const messageOf = (env: Env, facts: AlertFacts): AlertMessage => {
  const { subject, text } = wordsOf(
    facts.event,
    facts.organization?.name ?? null
  );
  return {
    subject: subjectFor(env, facts.test ? `Test: ${subject}` : subject),
    text: facts.test ? `${testLine}\n\n${text}` : text,
    link: facts.link,
    alerts: [facts],
  };
};

/** A minute, in milliseconds. */
const minute = 60_000;

/**
 * A test's samples, at `now`: an organization's deploy that failed a
 * while ago, and its recovery, as real alerts tell them, marked as tests
 * and linked to the Maintenance page. Nobody's: no organization of that
 * id exists, and nothing records them as alerts.
 */
const samplesOf = (env: Env, now: Date): [AlertFacts, AlertFacts] => {
  const clientId = "sample-organization";
  const organization = {
    name: "Sample organization",
    channel: "stable",
    pinnedReleaseId: null,
  } as const;
  const failedAt = new Date(now.getTime() - 12 * minute);
  const sample = { organization, test: true };
  return [
    factsOf(env, {
      ...sample,
      event: {
        kind: "deploy_failed",
        clientId,
        releaseId: "26.11.7",
        code: "release_rolled_back",
      },
      at: failedAt,
      path: "/platform/maintenance#alerts",
    }),
    factsOf(env, {
      ...sample,
      event: {
        kind: "deployed",
        clientId,
        releaseId: "26.11.8",
        failedAt: failedAt.getTime(),
      },
      at: now,
      // Discord shows one card of those that share a link.
      path: "/platform/maintenance?sample=recovery#alerts",
    }),
  ];
};

/**
 * A test alert sent at `now`: the sample failure's message, with its
 * recovery beside it where a channel lays alerts out (Discord).
 */
export const testMessageOf = (env: Env, now: Date): AlertMessage => {
  const samples = samplesOf(env, now);
  return { ...messageOf(env, samples[0]), alerts: samples };
};
