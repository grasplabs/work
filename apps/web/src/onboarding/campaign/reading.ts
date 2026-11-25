import { dayCount, todayIndex } from "./campaign-words.ts";
// Concepts only: what the progress page's concepts read from a campaign
// beyond its counts, worked out here as core would until it serves them:
// when a team has said enough, where the week is heading, which findings
// stand out, and what comes after the close.
import { daysBetween, smallTeam, talkedByDay } from "./fixtures.ts";
import type { Campaign, Finding, TeamPicture } from "./fixtures.ts";

/** How many of a team make its picture whole: six in ten, or its lead for a team under five. */
export const enoughOf = (team: TeamPicture): number =>
  team.invited < smallTeam ? 1 : Math.ceil(team.invited * 0.6);

/** How many of a team count toward enough, as the admin may see them. */
export const heardOf = (team: TeamPicture): number => {
  if (team.invited < smallTeam) {
    return team.leadTalked ? 1 : 0;
  }
  return team.talked;
};

/** How a team stands: said enough, on its way, or quiet three days in. */
export type Standing = "heard" | "going" | "quiet";

/** Days gone, today counted. */
const elapsedOf = (campaign: Campaign): number => todayIndex(campaign) + 1;

/** Days still to come before the close, today not counted. */
export const daysLeftOf = (campaign: Campaign): number =>
  Math.max(0, daysBetween(campaign.today, campaign.closes));

export const standingOf = (team: TeamPicture, campaign: Campaign): Standing => {
  if (heardOf(team) >= enoughOf(team)) {
    return "heard";
  }
  if (elapsedOf(campaign) < 3) {
    return "going";
  }
  if (team.invited < smallTeam) {
    return "quiet";
  }
  return team.talked / team.invited < 0.3 ? "quiet" : "going";
};

/** Where a count is heading by the close: today's pace, halving as the week goes on. */
const heading = (talked: number, campaign: Campaign): number =>
  Math.round(
    talked + (talked / elapsedOf(campaign)) * daysLeftOf(campaign) * 0.5
  );

/** How many will have talked by the close, at this pace; `null` while it is too early to say. */
export const projectedOf = (campaign: Campaign): number | null => {
  if (campaign.pace === "enough") {
    return campaign.talked;
  }
  if (elapsedOf(campaign) < 3) {
    return null;
  }
  return Math.min(campaign.invited, heading(campaign.talked, campaign));
};

/** The teams that won't have said enough by the close, at this pace. */
export const shortAtCloseOf = (campaign: Campaign): TeamPicture[] =>
  campaign.teams.filter((team) => {
    if (team.invited < smallTeam) {
      return !team.leadTalked;
    }
    return (
      Math.min(team.invited, heading(team.talked, campaign)) < enoughOf(team)
    );
  });

/** How many make the whole company's picture: every team's enough together. */
export const companyEnoughOf = (campaign: Campaign): number =>
  campaign.teams.reduce((total, team) => total + enoughOf(team), 0);

/**
 * How many talked by the end of each day so far, the whole company
 * together, and on each day alone. A small team's talks count in the
 * total here: added up, they say nothing about anyone.
 */
export const companyByDay = (
  campaign: Campaign
): { day: number; total: number }[] => {
  const days = dayCount(campaign);
  const daily = Array.from({ length: days }, () => 0);
  for (const team of campaign.teams) {
    const counted =
      team.invited < smallTeam ? { ...team, invited: smallTeam } : team;
    for (const [day, count] of talkedByDay(counted, campaign).entries()) {
      daily[day] = (daily[day] ?? 0) + count;
    }
  }
  let total = 0;
  return daily.map((day) => {
    total += day;
    return { day, total };
  });
};

/** A finding with its team. */
export interface Found {
  team: TeamPicture;
  finding: Finding;
}

/**
 * The findings that stand out, as core would rank them: each team's first
 * (how its work really runs), one a team, and among them one step told two
 * ways where there is one, since that is what Grasp settles for the admin.
 */
export const strikingOf = (campaign: Campaign, count: number): Found[] => {
  // Without teams, the one group's findings in order; with them, each team's first.
  const firsts = campaign.grouped
    ? campaign.teams.flatMap((team) => {
        const [finding] = team.findings;
        return finding === undefined ? [] : [{ team, finding }];
      })
    : campaign.teams.flatMap((team) =>
        team.findings.map((finding) => ({ team, finding }))
      );
  const chosen = firsts.slice(0, count);
  if (chosen.some((each) => each.finding.kind === "difference")) {
    return chosen;
  }
  // The last chosen team that told a step two ways gives that instead.
  const swap = chosen.findLastIndex((each) =>
    each.team.findings.some((finding) => finding.kind === "difference")
  );
  const told = chosen[swap]?.team.findings.find(
    (finding) => finding.kind === "difference"
  );
  if (swap === -1 || told === undefined || chosen[swap] === undefined) {
    return chosen;
  }
  return chosen.with(swap, { team: chosen[swap].team, finding: told });
};

/** A team's people as the admin may see them, one a square. */
export type Seat = "talked" | "today" | "waiting" | "unseen";

/**
 * A team's squares: who talked (today's apart), who is still to; in a
 * team under five, only its lead shows and the rest stay unseen.
 */
export const seatsOf = (team: TeamPicture, campaign: Campaign): Seat[] => {
  if (team.invited < smallTeam) {
    const rest = Array.from({ length: team.invited - 1 }, (): Seat => "unseen");
    return [team.leadTalked ? "talked" : "waiting", ...rest];
  }
  const todays =
    campaign.pace === "enough"
      ? 0
      : (talkedByDay(team, campaign)[todayIndex(campaign)] ?? 0);
  return Array.from({ length: team.invited }, (_, index): Seat => {
    if (index < team.talked - todays) {
      return "talked";
    }
    if (index < team.talked) {
      return "today";
    }
    return "waiting";
  });
};

/** An ISO day `days` after another. */
export const dayAfter = (iso: string, days: number): string => {
  const date = new Date(Date.parse(`${iso}T00:00:00Z`));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
