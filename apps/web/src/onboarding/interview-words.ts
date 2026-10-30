import type { Funnel } from "@grasp-os/shared/admin/admin-interviews";
import type { Phase } from "@grasp-os/shared/admin/interviews";
import { dateOn } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  LinkState,
  OrgView,
  PersonView,
  TeamView,
} from "@grasp-os/shared/admin/onboarding-admin";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";

import { formatDay } from "../format.ts";

// What the onboarding area says of the interviews, as the prototype's
// admin does (`components/admin/admin-words.ts`, `org-progress.tsx`,
// `org-people.tsx`): one place for the words, so the teams, the people and
// the transcripts say the same.

/** The day `day` of the interviews, as a date. */
export const dayDate = (view: OrgView, day: number): string =>
  formatDay(dateOn(view.org, day));

export const linkTitles: Record<LinkState, MessageDescriptor> = {
  waiting: msg({ message: "No link yet", context: "where a link stands" }),
  invited: msg({ message: "Link out", context: "where a link stands" }),
  opened: msg({ message: "Opened", context: "where a link stands" }),
  progress: msg({ message: "Talking now", context: "where a link stands" }),
  incomplete: msg({
    message: "Stopped halfway",
    context: "where a link stands",
  }),
  completed: msg({ message: "Talked", context: "where a link stands" }),
  expired: msg({
    message: "Closed without talking",
    context: "where a link stands",
  }),
  away: msg({ message: "Away", context: "where a link stands" }),
};

export const phaseTitles: Record<Phase, MessageDescriptor> = {
  open: msg({ message: "Hello", context: "part of an interview" }),
  you: msg({ message: "You and AI", context: "part of an interview" }),
  anchor: msg({ message: "A recent case", context: "part of an interview" }),
  story: msg({ message: "How it went", context: "part of an interview" }),
  steps: msg({ message: "The steps", context: "part of an interview" }),
  exceptions: msg({
    message: "What goes differently",
    context: "part of an interview",
  }),
  numbers: msg({ message: "The numbers", context: "part of an interview" }),
  result: msg({ message: "The result", context: "part of an interview" }),
  readback: msg({ message: "The read-back", context: "part of an interview" }),
};

export const tagTitles: Record<FactTag, MessageDescriptor> = {
  step: msg({ message: "Step", context: "kind of fact" }),
  system: msg({ message: "System", context: "kind of fact" }),
  handoff: msg({ message: "Handoff", context: "kind of fact" }),
  wait: msg({ message: "Waiting", context: "kind of fact" }),
  exception: msg({ message: "Exception", context: "kind of fact" }),
  rule: msg({ message: "Rule", context: "kind of fact" }),
  judgment: msg({ message: "Judgment", context: "kind of fact" }),
  workaround: msg({ message: "Workaround", context: "kind of fact" }),
  ai: msg({ message: "AI", context: "kind of fact" }),
  wish: msg({ message: "Wish", context: "kind of fact" }),
  number: msg({ message: "Number", context: "kind of fact" }),
  done: msg({ message: "Done right", context: "kind of fact" }),
  stop: msg({ message: "When to stop", context: "kind of fact" }),
  case: msg({ message: "Example", context: "kind of fact" }),
  term: msg({ message: "Their word", context: "kind of fact" }),
  next: msg({ message: "Who comes next", context: "kind of fact" }),
  work: msg({ message: "Piece of work", context: "kind of fact" }),
  who: msg({ message: "Who does it", context: "kind of fact" }),
};

/** The steps everyone goes through with their link, from being asked to having talked. */
export const funnelSteps = [
  "asked",
  "out",
  "opened",
  "started",
  "talked",
] as const satisfies readonly (keyof Funnel)[];

export const funnelTitles: Record<
  (typeof funnelSteps)[number],
  MessageDescriptor
> = {
  asked: msg({ message: "Asked", context: "step of the interviews" }),
  out: msg({ message: "Link out", context: "step of the interviews" }),
  opened: msg({ message: "Opened", context: "step of the interviews" }),
  started: msg({ message: "Started", context: "step of the interviews" }),
  talked: msg({ message: "Talked", context: "step of the interviews" }),
};

/** How many of a team talked, of how many were asked. */
export const talkedText = (i18n: I18n, talked: number, asked: number) =>
  i18n._(msg`${talked} of ${asked} talked`);

/** Where a team stands, in a few words. */
export const standsText = (
  i18n: I18n,
  view: OrgView,
  { next, lead, sent }: TeamView
): string => {
  const leadName = lead?.person.first ?? "";
  switch (next.kind) {
    case "off": {
      return i18n._(msg`Does not take part`);
    }
    case "lead-unknown": {
      return i18n._(msg`The company still has to name its lead`);
    }
    case "not-told": {
      return i18n._(msg`Gets its links once the team is told`);
    }
    case "lead": {
      if (lead === null) {
        return i18n._(msg`Its links go out on the first day`);
      }
      return next.reminded
        ? i18n._(msg`${leadName} was reminded and has not talked yet`)
        : i18n._(msg`Waits for ${leadName} to talk first`);
    }
    case "done": {
      return i18n._(msg`Everyone has talked`);
    }
    case "closed": {
      const { missed } = next;
      return plural(missed, {
        one: "Closed. # person did not talk",
        other: "Closed. # people did not talk",
      });
    }
    case "talking": {
      if (sent === null) {
        return i18n._(msg`Links out`);
      }
      const since = dayDate(view, sent);
      return i18n._(msg`Links out since ${since}`);
    }
    default: {
      return next satisfies never;
    }
  }
};

/** The last thing that happened with someone's link, and when. */
export const lastText = (
  i18n: I18n,
  view: OrgView,
  { last }: PersonView
): string => {
  if (last === null) {
    return "";
  }
  const date = dayDate(view, last.day);
  switch (last.what) {
    case "sent": {
      return i18n._(msg`Link out on ${date}`);
    }
    case "opened": {
      return i18n._(msg`Opened on ${date}`);
    }
    case "reminded": {
      return i18n._(msg`Reminded on ${date}`);
    }
    case "stopped": {
      return i18n._(msg`Stopped on ${date}`);
    }
    case "completed": {
      return i18n._(msg`Finished on ${date}`);
    }
    default: {
      return last.what satisfies never;
    }
  }
};

/** What goes with where someone's link stands, on a second line. */
export const besideText = (i18n: I18n, each: PersonView): string => {
  if (each.deleted) {
    return i18n._(msg`Deleted because they asked`);
  }
  if (each.stoppedAt !== null) {
    const part = i18n._(phaseTitles[each.stoppedAt]);
    return i18n._(msg`Stopped at: ${part}`);
  }
  return each.out ? i18n._(msg`Team does not take part`) : "";
};

/** Where someone's link stands, in a word or two. */
export const stateText = (i18n: I18n, each: PersonView): string =>
  each.out && each.state === "away"
    ? i18n._(msg`Not asked`)
    : i18n._(linkTitles[each.state]);

/** What Stephen asks someone about: a lead the team's work; anyone else the work they do most. */
export const askedAboutText = (i18n: I18n, lead: boolean): string =>
  lead
    ? i18n._(msg`The team's work, and who to ask`)
    : i18n._(msg`The work they do most, as they say`);
