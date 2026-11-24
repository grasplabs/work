import { i18n } from "@lingui/core";
import type { I18n, MessageDescriptor } from "@lingui/core";
// What the campaign page says, read from a campaign (fixtures.ts), as
// messages the page renders with `i18n._()`. Team names and findings are
// core's data and stay as they are.
import { msg, plural } from "@lingui/core/macro";

import { formatList } from "../../format.ts";
import { daysBetween, smallTeam } from "./fixtures.ts";
import type { Campaign, Finding, TeamPicture } from "./fixtures.ts";

/** Words as the page says them: a message translated, core's data as it is. */
export const say = (
  translator: I18n,
  words: MessageDescriptor | string
): string => (typeof words === "string" ? words : translator._(words));

/** How many days the campaign runs, its first and its close day counted. */
export const dayCount = (campaign: Campaign): number =>
  daysBetween(campaign.start, campaign.closes) + 1;

/** Which day of the campaign today is, from 0. */
export const todayIndex = (campaign: Campaign): number =>
  daysBetween(campaign.start, campaign.today);

/** Is it going well: the title, and one plain line under it. */
export const statementOf = (
  campaign: Campaign
): { lead: MessageDescriptor; rest: MessageDescriptor } => {
  const { talked, invited } = campaign;
  if (campaign.pace === "started") {
    return {
      lead: msg`We’ve started.`,
      rest: msg`Your invitations reached all ${invited} people. ${plural(
        talked,
        { one: "# has talked already.", other: "# have talked already." }
      )}`,
    };
  }
  if (campaign.pace === "onPace") {
    return {
      lead: msg`Going well.`,
      rest: campaign.grouped
        ? msg`${talked} of ${invited} have talked. Every team has begun.`
        : msg`${talked} of ${invited} have talked.`,
    };
  }
  if (campaign.pace === "quiet") {
    return {
      lead: msg`Going well, mostly.`,
      rest: msg`${talked} of ${invited} have talked. One team is still quiet.`,
    };
  }
  return {
    lead: msg`We have what we need.`,
    rest: msg`${talked} of ${invited} talked. Thank you.`,
  };
};

/** A row's name: the team's, or everyone in a company without teams. */
export const rowName = (
  each: TeamPicture,
  grouped: boolean
): MessageDescriptor | string => (grouped ? each.name : msg`Everyone`);

/** How many talked, as the admin may see it: counts for five or more, the lead alone under five. */
export const talkedWords = (each: TeamPicture): MessageDescriptor => {
  if (each.invited < smallTeam) {
    return each.leadTalked ? msg`Lead talked` : msg`Lead not yet`;
  }
  const { talked, invited } = each;
  return msg`${talked} of ${invited} talked`;
};

/**
 * A finding as plain sentences: one told two ways says that Grasp settles
 * it, so the admin needn't steer.
 */
export const findingWords = (
  finding: Finding,
  grouped: boolean
): MessageDescriptor | string => {
  const { text } = finding;
  if (finding.kind !== "difference") {
    return text;
  }
  return grouped
    ? msg`${text} We’ll settle it with their lead.`
    : msg`${text} We’ll settle it with whoever knows the work best.`;
};

/** How it runs and when it closes, in one quiet line. */
export const runningWords = (campaign: Campaign): MessageDescriptor => {
  if (campaign.pace === "enough") {
    return msg`The interviews close tonight. We’ll tell you when Grasp opens.`;
  }
  const left = Math.max(0, daysBetween(campaign.today, campaign.closes));
  if (left === 0) {
    return msg`Listening. The interviews close tonight.`;
  }
  const day = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${campaign.closes}T00:00:00Z`));
  return msg`Listening. The interviews close ${day}, ${plural(left, {
    one: "in # day.",
    other: "in # days.",
  })}`;
};

/** Who declined, by first name; none when nobody did. */
export const declinedWords = (campaign: Campaign): MessageDescriptor | null => {
  if (campaign.declined.length === 0) {
    return null;
  }
  const names = formatList(
    campaign.declined.map((name) => name.split(" ")[0] ?? name)
  );
  return msg`${names} declined the interview.`;
};
