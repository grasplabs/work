/**
 * What the admin's audit log keeps of a client, in sentences staff read:
 * what staff did by hand and what the admin did by itself. Its Setup's
 * History and its overview's recent activity both say it this way.
 */
import { z } from "zod";

import type { HistoryEntry } from "../clients/queries.ts";
import type { SealedSecretName } from "../deploy/sealed-secrets.ts";
import { channelIds } from "../rollout/channel-ids.ts";
import { channelWords } from "../rollout/channel-words.ts";

/** What a channel change records besides. */
const channelSchema = z.object({ channel: z.enum(channelIds) });

/** What setting each sealed secret did, for its log. */
const sealedSecretWords: Record<SealedSecretName, string> = {
  TEAMS_BOT_SECRET: "Set its Teams bot's secret.",
  SLACK_BOT_TOKEN: "Set its Slack app's bot token.",
  SLACK_SIGNING_SECRET: "Set its Slack app's signing secret.",
};

/** Whether `target` names a sealed secret. */
const isSealedSecretName = (
  target: string | null
): target is SealedSecretName =>
  target !== null && Object.hasOwn(sealedSecretWords, target);

/** What staff did by hand that needs nothing of its event to say, in a sentence. */
const plainEventWords: Readonly<Record<string, string>> = {
  "client.create": "Added it.",
  "client.rotate_secrets": "Rotated its secrets.",
  "client.sign_in": "Changed how its people sign in.",
  "client.teams_bot": "Changed its Teams bot.",
  "client.staff_window": "Opened or closed Grasp's staff window.",
  "client.retry": "Retried its deploy.",
  "client.offboard": "Offboarded it.",
};

/** A move to another channel, in a sentence, from what its event records. */
const channelChangeWords = (detail: string | null): string => {
  const channel = channelSchema.safeParse(JSON.parse(detail ?? "null")).data
    ?.channel;
  return channel === undefined
    ? "Moved it to another channel."
    : `Moved it to ${channelWords[channel]}.`;
};

/** What staff did by hand, in a sentence. */
export const eventWords = ({
  action,
  target,
  detail,
}: Pick<HistoryEntry, "action" | "target" | "detail">): string => {
  switch (action) {
    case "client.place": {
      return `Placed it in ${target ?? "a hosting destination"}.`;
    }
    case "client.provision_placed": {
      return `Started provisioning it on ${target ?? "a release"}.`;
    }
    case "client.channel": {
      return channelChangeWords(detail);
    }
    case "client.pin": {
      return `Pinned it to ${target ?? "a release"}.`;
    }
    case "client.unpin": {
      return "Let it follow its channel again.";
    }
    case "client.sealed_secret": {
      return isSealedSecretName(target)
        ? sealedSecretWords[target]
        : "Set one of its secrets.";
    }
    case "client.apply_settings": {
      return "Applied its settings.";
    }
    case "client.stripe_customer": {
      return target === null
        ? "Unlinked it from Stripe."
        : `Linked it to ${target} in Stripe.`;
    }
    case "client.attio_company": {
      return target === null
        ? "Unlinked it from Attio."
        : `Linked it to ${target} in Attio.`;
    }
    default: {
      return plainEventWords[action] ?? action;
    }
  }
};

/** The step a provisioning event is the end of (src/hosting/operation.ts, `provisionSteps`). */
const provisionStepOf =
  /^provision\.(?<step>validated|resources|snapshot|migrations|connect|core|probe|route)$/u;

/** What the admin did by itself, in a sentence; null for an action it has no words for. */
const systemEventWords = ({
  action,
  target,
}: Pick<HistoryEntry, "action" | "target">): string | null => {
  const on = target === null ? "" : ` of ${target}`;
  switch (action) {
    case "deploy.start": {
      return `Started its deploy${on}.`;
    }
    case "deploy.done": {
      return `Its deploy${on} is live.`;
    }
    case "deploy.fail": {
      return `Its deploy${on} failed.`;
    }
    case "provision.start": {
      return `Started setting it up${target === null ? "" : ` on ${target}`}.`;
    }
    case "provision.done": {
      return `Set it up${target === null ? "" : ` on ${target}`}.`;
    }
    case "provision.fail": {
      return "Its setting up stopped.";
    }
    case "provision.worker_live": {
      return `One of its Workers went live${target === null ? "" : ` on ${target}`}.`;
    }
    case "client.rotation_live": {
      return "Its rotated secrets went live.";
    }
    default: {
      const step = provisionStepOf.exec(action)?.groups?.step;
      return step === undefined ? null : `Its ${step} step is done.`;
    }
  }
};

/** An error's code in what an event records besides, when it records one. */
const errorSchema = z.object({ error: z.string() });
export const errorOf = (detail: string | null): string | null => {
  try {
    return (
      errorSchema.safeParse(JSON.parse(detail ?? "null")).data?.error ?? null
    );
  } catch {
    return null;
  }
};

/** One entry in a sentence: what happened, or its action as the log names it. */
export const entryWords = (entry: HistoryEntry): string => {
  const words = systemEventWords(entry) ?? eventWords(entry);
  if (words !== entry.action) {
    return words;
  }
  return entry.target === null
    ? entry.action
    : `${entry.action} ${entry.target}`;
};

/** Who did it: a staff member by email, or the admin by itself. */
export const actorWords = (actor: string): string =>
  actor === "system" ? "Grasp, by itself" : actor;

/** What the log notes as a setting up goes: its steps say the same. */
export const shownEntries = (
  history: readonly HistoryEntry[]
): HistoryEntry[] =>
  history.filter(({ action }) => action !== "provision.progress");
