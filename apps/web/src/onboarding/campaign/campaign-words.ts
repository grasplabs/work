// Concepts only: the words every campaign concept shares, read from a
// campaign (fixtures.ts), so the three say the same things in different
// shapes. English only: the concepts are never merged.
import { i18n } from "@lingui/core";

import { daysBetween, smallTeam } from "./fixtures.ts";
import type { Campaign, TeamPicture } from "./fixtures.ts";

/** An ISO day as "Monday 30 November". */
export const longDay = (iso: string): string =>
  new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));

/** An ISO day as "Mon 30 Nov". */
export const shortDay = (iso: string): string =>
  new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));

/** An ISO day as its weekday alone: "Monday". */
export const weekday = (iso: string): string =>
  new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));

/** Days until the interviews close: 0 on the close day. */
export const daysLeft = (campaign: Campaign): number =>
  Math.max(0, daysBetween(campaign.today, campaign.closes));

/** "3 days left", "1 day left", "Closes today". */
export const daysLeftWords = (campaign: Campaign): string => {
  const left = daysLeft(campaign);
  if (left === 0) {
    return "closes today";
  }
  return left === 1 ? "1 day left" : `${left} days left`;
};

/** Which day of the campaign today is, from 1. */
export const dayNumber = (campaign: Campaign): number =>
  daysBetween(campaign.start, campaign.today) + 1;

/** How many days the campaign runs, its first and its close day counted. */
export const dayCount = (campaign: Campaign): number =>
  daysBetween(campaign.start, campaign.closes) + 1;

/** Is it going well, as a badge: its words, and the status it stands for. */
export const paceOf = (
  campaign: Campaign
): { label: string; variant: "default" | "success" | "warning" } => {
  switch (campaign.pace) {
    case "started": {
      return { label: "Started today", variant: "default" };
    }
    case "onPace": {
      return { label: "On pace", variant: "success" };
    }
    case "quiet": {
      return {
        label: campaign.grouped ? "One team is quiet" : "Quiet",
        variant: "warning",
      };
    }
    case "enough": {
      return { label: "Enough known", variant: "success" };
    }
    default: {
      return { label: "", variant: "default" };
    }
  }
};

/** How many talked, as the admin may see it: counts for five or more, the lead alone under five. */
export const talkedWords = (each: TeamPicture, grouped: boolean): string => {
  if (each.invited < smallTeam) {
    return each.leadTalked ? "Lead talked" : "Lead not yet";
  }
  if (!grouped) {
    return `${each.talked} of ${each.invited} people talked`;
  }
  return `${each.talked} of ${each.invited} talked`;
};

/** A team past a third of the way with fewer than a third talked is quiet. */
export const isQuiet = (each: TeamPicture, campaign: Campaign): boolean =>
  campaign.asks.some((ask) => ask.kind === "quiet" && ask.team === each.name);

/** The quiet figure: how much Grasp knows. */
export const knownWords = (campaign: Campaign): string =>
  `${campaign.known}% known`;

/** Is it going well, as the brand's statement: a short first half, and a quieter second. */
export const statementOf = (
  campaign: Campaign
): { lead: string; rest: string } => {
  const { talked, invited } = campaign;
  switch (campaign.pace) {
    case "started": {
      return {
        lead: "We’ve started.",
        rest: `Your invitations reached all ${invited} people, and ${talked} have talked already.`,
      };
    }
    case "onPace": {
      return {
        lead: "Going well.",
        rest: campaign.grouped
          ? `${talked} of ${invited} have talked, and every team has begun.`
          : `${talked} of ${invited} have talked.`,
      };
    }
    case "quiet": {
      return {
        lead: "Going well, mostly.",
        rest: `${talked} of ${invited} have talked. One team is still quiet.`,
      };
    }
    case "enough": {
      return {
        lead: "We have what we need.",
        rest: `${talked} of ${invited} talked. Thank you.`,
      };
    }
    default: {
      return { lead: "", rest: "" };
    }
  }
};

/** When: the close, the one date that matters on this page. */
export const whenWords = (campaign: Campaign): string =>
  campaign.pace === "enough"
    ? "The interviews close tonight"
    : `The interviews close ${shortDay(campaign.closes)}, ${daysLeftWords(campaign)}`;
