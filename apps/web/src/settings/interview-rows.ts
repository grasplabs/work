import type { LinkToSend } from "@grasp-os/shared/onboarding";
import type {
  Campaign,
  CampaignTeam,
} from "@grasp-os/shared/onboarding-campaign";

import { todayIndex } from "../onboarding/campaign/campaign-words.ts";

// Settings › Interviews: what its two tables list, read from what core
// tells the admin (`onboarding.campaign`, `onboarding.links`). Pure.

/**
 * Where someone's link stands, as far as core tells the admin: its mail
 * failed for good (`failed`), it is out and the admin still has to send it
 * (`send`, only where the deployment sends no mail), or it went (`sent`).
 */
export type LinkStatus = "failed" | "send" | "sent";

/** One row of the links' table: a person core names, and their link. */
export interface LinkRow {
  person: string;
  name: string;
  /** Their team's name. */
  team: string;
  /** Empty when they have none. */
  email: string;
  /** The link's path; null where core gave none. */
  path: string | null;
  status: LinkStatus;
}

/** The statuses in the order the table starts in: what needs the admin first. */
const statusOrder: readonly LinkStatus[] = ["failed", "send", "sent"];

/** Where a status stands in that order. */
export const statusRank = (status: LinkStatus): number =>
  statusOrder.indexOf(status);

/** Whether a row needs the admin: an address to correct, or a link to send. */
export const needsAdmin = (row: LinkRow): boolean => row.status !== "sent";

/**
 * Everyone whose link is out, and everyone whose link mail failed (the
 * campaign's `mail` asks, with the address as the staff list has it), each
 * once. A link that isn't out yet is no row: nothing can be done with it.
 */
export const linkRows = (
  campaign: Campaign,
  links: readonly LinkToSend[],
  mailSends: boolean
): LinkRow[] => {
  const failed = campaign.asks.filter((ask) => ask.kind === "mail");
  const failedPeople = new Set(failed.map(({ person }) => person));
  const rows: LinkRow[] = failed.map((ask) => ({
    person: ask.person,
    name: ask.name,
    team: ask.team,
    email: ask.email,
    path: links.find(({ person }) => person === ask.person)?.path ?? null,
    status: "failed",
  }));
  for (const link of links) {
    if (link.path !== null && !failedPeople.has(link.person)) {
      let status: LinkStatus = "sent";
      if (link.mailFailed) {
        status = "failed";
      } else if (!mailSends && link.fresh) {
        status = "send";
      }
      rows.push({
        person: link.person,
        name: link.name,
        team: link.team,
        email: link.email,
        path: link.path,
        status,
      });
    }
  }
  return rows.toSorted(
    (one, other) =>
      statusRank(one.status) - statusRank(other.status) ||
      one.name.localeCompare(other.name)
  );
};

/** Whether the interviews run today: a reminder goes only then. */
export const runsToday = (campaign: Campaign): boolean =>
  todayIndex(campaign) >= 0 && campaign.today <= campaign.closes;

/** Whether everyone asked in a team has talked, where its numbers show. */
export const everyoneTalked = (team: CampaignTeam): boolean =>
  team.asked !== null && team.talked !== null && team.talked >= team.asked;

/** How many of a team are still to talk; null where its numbers are hidden. */
export const stillToTalk = (team: CampaignTeam): number | null =>
  team.asked === null || team.talked === null
    ? null
    : Math.max(team.asked - team.talked, 0);
