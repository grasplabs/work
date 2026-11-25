// Concepts only: what the progress page's concepts say beyond the campaign
// page's own words (campaign-words.ts), as messages rendered with `i18n._()`.
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";

import { formatList } from "../../../format.ts";
import { dayCount, todayIndex } from "../campaign-words.ts";
import { smallTeam } from "../fixtures.ts";
import type { Campaign, TeamPicture } from "../fixtures.ts";
import {
  dayAfter,
  daysLeftOf,
  enoughOf,
  heardOf,
  projectedOf,
  shortAtCloseOf,
  standingOf,
} from "../reading.ts";

/** An ISO day as the page's language writes it: `weekday` long or short. */
export const dayWords = (
  translator: I18n,
  iso: string,
  weekday: "long" | "short" = "long"
): string =>
  new Intl.DateTimeFormat(translator.locale, {
    weekday,
    day: "numeric",
    month: weekday === "long" ? "long" : "short",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));

/** Today, and how far into the interviews it is. */
export const todayWords = (
  translator: I18n,
  campaign: Campaign
): MessageDescriptor => {
  const date = dayWords(translator, campaign.today);
  const day = todayIndex(campaign) + 1;
  const days = dayCount(campaign);
  return msg`${date}, day ${day} of ${days}`;
};

/** Where the interviews are heading by the close, in one sentence; none on the last day. */
export const forecastWords = (
  translator: I18n,
  campaign: Campaign
): MessageDescriptor | null => {
  const projected = projectedOf(campaign);
  if (campaign.pace === "enough" || daysLeftOf(campaign) === 0) {
    return null;
  }
  if (projected === null) {
    return msg`Most people talk in the first three days, so the next two count most.`;
  }
  const day = new Intl.DateTimeFormat(translator.locale, {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(`${campaign.closes}T00:00:00Z`));
  const short = shortAtCloseOf(campaign);
  if (!campaign.grouped) {
    return short.length === 0
      ? msg`At this pace about ${projected} will have talked by ${day}. That is enough.`
      : msg`At this pace about ${projected} will have talked by ${day}. That is not quite enough yet.`;
  }
  if (short.length === 0) {
    return msg`At this pace about ${projected} will have talked by ${day}, enough to understand every team.`;
  }
  const names = formatList(short.map((team) => team.name));
  return msg`At this pace about ${projected} will have talked by ${day}, enough to understand every team but ${names}.`;
};

/** How a team stands, in a short line: said enough, how many more, or quiet. */
export const standingWords = (
  team: TeamPicture,
  campaign: Campaign
): MessageDescriptor => {
  const standing = standingOf(team, campaign);
  if (standing === "heard") {
    return msg`Enough to understand it`;
  }
  if (team.invited < smallTeam) {
    return standing === "quiet"
      ? msg`Quiet: the lead hasn’t talked`
      : msg`Waiting for the lead`;
  }
  const more = enoughOf(team) - heardOf(team);
  return standing === "quiet"
    ? msg`Quiet: ${plural(more, { one: "# more needed", other: "# more needed" })}`
    : msg`${plural(more, { one: "# more for enough", other: "# more for enough" })}`;
};

/** One step from here to Grasp opening: when, and what. */
export interface Milestone {
  id: string;
  /** When, written: a day, or a word for it. */
  when: MessageDescriptor | string;
  what: MessageDescriptor;
  /** Done, today's, or to come. */
  state: "done" | "now" | "later";
}

/** The way from the invitations to Grasp opening, today's step marked. */
export const milestonesOf = (
  translator: I18n,
  campaign: Campaign
): Milestone[] => {
  const closing = daysLeftOf(campaign) === 0;
  const started = dayWords(translator, campaign.start, "short");
  const closes = dayWords(translator, campaign.closes, "short");
  const written = dayWords(translator, dayAfter(campaign.closes, 3), "short");
  return [
    {
      id: "sent",
      when: started,
      what: msg`Invitations went out`,
      state: "done",
    },
    {
      id: "listening",
      when: msg`Now`,
      what: msg`Listening`,
      state: closing ? "done" : "now",
    },
    {
      id: "close",
      when: closes,
      what: msg`The interviews close`,
      state: closing ? "now" : "later",
    },
    {
      id: "written",
      when: msg`By ${written}`,
      what: campaign.grouped
        ? msg`We write down how each team works`
        : msg`We write down how the work runs`,
      state: "later",
    },
    {
      id: "checked",
      when: msg`Then`,
      what: campaign.grouped
        ? msg`You and your leads look it over`
        : msg`You look it over`,
      state: "later",
    },
    {
      id: "opens",
      when: msg`After`,
      what: msg`Grasp opens for everyone`,
      state: "later",
    },
  ];
};

/** Nothing for the admin to do, said as reassurance. */
export const nothingForYou = msg`Nothing needs you today.`;
