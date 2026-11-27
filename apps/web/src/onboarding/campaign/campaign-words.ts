import { minTalkedShown } from "@grasp-os/shared/onboarding";
import type {
  Campaign,
  CampaignTeam,
} from "@grasp-os/shared/onboarding-campaign";
import { i18n } from "@lingui/core";
import type { I18n, MessageDescriptor } from "@lingui/core";
// What the campaign page says, read from the campaign as core tells it
// (`onboarding.campaign`), as messages the page renders with `i18n._()`.
// Team names are core's data and stay as they are.
import { msg, plural } from "@lingui/core/macro";

/** Words as the page says them: a message translated, core's data as it is. */
export const say = (
  translator: I18n,
  words: MessageDescriptor | string
): string => (typeof words === "string" ? words : translator._(words));

/** Whole days from `from` to `to`, ISO days both. */
const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000
  );

/** Which day of the campaign today is, from 0; below 0 before it starts. */
export const todayIndex = (campaign: Campaign): number =>
  daysBetween(campaign.start, campaign.today);

/** False for a company of one group: the word "team" never shows. */
export const isGrouped = (campaign: Campaign): boolean =>
  campaign.teams.length > 1;

/** A day in full, as the page's language writes it. */
const dayWords = (day: string): string =>
  new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

/**
 * Where the interviews stand, in a title and one plain line under it, from
 * what core counts: everyone the admin's numbers cover, the teams' leads
 * with them. Never how it is going: core says no such thing.
 */
export const statementOf = (
  campaign: Campaign
): { lead: MessageDescriptor; rest: MessageDescriptor } => {
  const talked = campaign.talked + campaign.leadsTalked;
  const invited = campaign.asked + campaign.leads;
  if (todayIndex(campaign) < 0) {
    const day = dayWords(campaign.start);
    return {
      lead: msg`We start ${day}.`,
      rest: msg`Nobody has been asked yet.`,
    };
  }
  if (campaign.ready) {
    return {
      lead: msg`We have what we need.`,
      rest: msg`${talked} of ${invited} talked. Thank you.`,
    };
  }
  const quiet = campaign.teams.filter((team) => team.quiet).length;
  return {
    lead: msg`We’ve started.`,
    rest:
      quiet === 0
        ? msg`${talked} of ${invited} have talked.`
        : msg`${talked} of ${invited} have talked. ${plural(quiet, {
            one: "One team is still quiet.",
            other: "# teams are still quiet.",
          })}`,
  };
};

/** A row's name: the team's, or everyone in a company without teams. */
export const rowName = (
  each: CampaignTeam,
  grouped: boolean
): MessageDescriptor | string => (grouped ? each.name : msg`Everyone`);

/**
 * What a team's row says under its name, as the admin may see it: how many
 * talked of how many asked; while too few talked, only that; and for a
 * team under five, whether its lead talked, or nothing where it has none.
 */
export const talkedWords = (each: CampaignTeam): MessageDescriptor | null => {
  if (each.asked === null) {
    if (!each.led) {
      return null;
    }
    return each.leadTalked ? msg`Lead talked` : msg`Lead not yet`;
  }
  if (each.talked === null) {
    const least = minTalkedShown;
    const of = each.asked;
    return msg`Fewer than ${least} of ${of}`;
  }
  const { talked, asked: invited } = each;
  return msg`${talked} of ${invited} talked`;
};

/** How it runs and when it closes, in one quiet line. */
export const runningWords = (campaign: Campaign): MessageDescriptor => {
  const left = daysBetween(campaign.today, campaign.closes);
  const day = dayWords(campaign.closes);
  if (todayIndex(campaign) < 0) {
    return msg`The interviews run until ${day}.`;
  }
  if (left < 0) {
    return msg`The interviews are over. We’ll tell you when Grasp opens.`;
  }
  if (left === 0) {
    return msg`Listening. The interviews close tonight.`;
  }
  return msg`Listening. The interviews close ${day}, ${plural(left, {
    one: "in # day.",
    other: "in # days.",
  })}`;
};

/** How much Grasp knows against its go, in one quiet line. */
export const knownWords = (campaign: Campaign): MessageDescriptor => {
  const { known, threshold } = campaign;
  return msg`We know ${known}% of how your company works. Grasp opens for everyone from ${threshold}%.`;
};
