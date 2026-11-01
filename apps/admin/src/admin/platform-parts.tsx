import { cn } from "@grasp-os/ui/lib/utils";

/**
 * The parts and words of the admin's Platform page, ported from the
 * prototype (grasplabs/prototype `components/admin/platform-parts.tsx`
 * and `platform-words.ts`): how a company stands, and the admin's own
 * records in words staff read.
 */
import type { AttentionReason } from "../hosting/attention.ts";
import type { NotStarted } from "../hosting/placement.ts";
import type { ClientProgress } from "../rollout/progress.ts";
import type { StaffEvent } from "./platform-data.ts";
import type { PlatformNeed, Standing } from "./platform.ts";

/** Where a company stands against its channel. */
export const clientStateWords: Record<ClientProgress["state"], string> = {
  up_to_date: "Up to date",
  deploying: "Deploying",
  waiting: "Waiting",
  failed: "Failed",
  pinned: "Pinned",
  no_release: "No release yet",
};

export const standingWords: Record<Standing, string> = {
  attention: "Needs a look",
  setup: "Being set up",
  unread: "Not read",
  healthy: "Healthy",
  offboarded: "Offboarded",
};

const driftWords: Record<
  Extract<PlatformNeed, { kind: "drift" }>["drift"],
  string
> = {
  drifted: "Runs another version than the admin made live",
  split: "Runs two versions at once",
  off_pin: "Runs another release than it is pinned to",
};

/** Why setting a company up hasn't started, in a line with the next step. */
const notStartedLine: Record<NotStarted | "ready", string> = {
  no_destination: "Not started: no hosting destination ready.",
  no_release: "Not started: promote a release to its channel first.",
  on_prem: "On-premises: on-prem setup arrives with GRA-1291.",
  ready: "Not started: provision it from its Setup.",
};

/** Why setting a company up needs a person, in a line with the next step. */
export const attentionWords: Record<AttentionReason, string> = {
  stuck:
    "Needs attention: Grasp's automatic retries haven't finished setting it up. Retry now from its Setup once it's fixed.",
  needs_person:
    "Needs attention: setting it up stopped for something Grasp can't fix by itself. Retry now from its Setup once it's fixed.",
};

/** What a company needs, in a line. */
export const needWords = (need: PlatformNeed): string => {
  switch (need.kind) {
    case "not_started": {
      return notStartedLine[need.why ?? "ready"];
    }
    case "needs_attention": {
      return attentionWords[need.reason];
    }
    case "stopped": {
      return "Stopped: Grasp is retrying it by itself.";
    }
    case "setup_unread": {
      return "Being set up: status unavailable just now. Its Setup reads it again.";
    }
    case "failed": {
      return `Its last deploy failed (${need.releaseId}).`;
    }
    case "drift": {
      return `${driftWords[need.drift]}.`;
    }
    default: {
      return "";
    }
  }
};

/**
 * What someone at Grasp did, in a line: who, then what, naming the company
 * by `nameOf` and the release by its id.
 */
export const eventWords = (
  event: StaffEvent,
  nameOf: (clientId: string) => string
): string => {
  const company = event.clientId === null ? "" : nameOf(event.clientId);
  const target = event.target ?? "";
  const what: Record<StaffEvent["action"], string> = {
    "channel.promote": `set a channel to ${target}`,
    "channel.retry": "retried a channel's failed deploys",
    "secrets.roll_out": "rolled out the shared secrets",
    "client.create": `added ${company}`,
    "client.discard": `discarded ${company}, which was never placed`,
    "client.channel": `moved ${company} to another channel`,
    "client.pin": `pinned ${company} to ${target}`,
    "client.unpin": `unpinned ${company}`,
    "client.rotate_secrets": `rotated ${company}'s secrets`,
    "client.apply_settings": `applied ${company}'s settings`,
    "client.sign_in": `changed how ${company}'s people sign in`,
    "client.sealed_secret": `set one of ${company}'s secrets`,
    "client.teams_bot": `changed ${company}'s Teams bot`,
    "platform.grasp_client":
      company === ""
        ? "chose no organization as Grasp's own"
        : `chose ${company} as Grasp's own organization`,
  };
  return `${event.actor} ${what[event.action]}`;
};

const standingDot: Record<Standing, string> = {
  attention: "bg-status-attention",
  setup: "bg-foreground",
  unread: "bg-muted-foreground",
  healthy: "bg-status-agreed",
  offboarded: "bg-border",
};

/** How a company stands, as a dot and a word. */
export const StandingMark = ({ standing }: { standing: Standing }) => (
  <span
    className={cn(
      "flex items-center gap-2",
      standing === "attention" && "text-status-attention"
    )}
  >
    <span
      aria-hidden="true"
      className={cn("size-2 flex-none rounded-full", standingDot[standing])}
    />
    {standingWords[standing]}
  </span>
);
