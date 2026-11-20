import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// The starting points Grasp offers when someone makes an agent (new-agent.tsx): a job most
// companies have, with the names it suggests, what the agent is told and, when it works on its
// own, what it is asked each time. Fixed choices, so constants here; whatever is chosen is only a
// start, and every word of it can be changed before the agent is made.

/** One starting point. */
export interface AgentTemplate {
  /** A stable key: what the choice sends. */
  key: string;
  /** The choice, short. */
  label: MessageDescriptor;
  /** One line under it. */
  description: MessageDescriptor;
  /** The names Grasp suggests for it. */
  names: readonly MessageDescriptor[];
  /** What it is for, in one sentence. */
  job: MessageDescriptor;
  /** What it is told. */
  instructions: MessageDescriptor;
}

export const agentTemplates: readonly AgentTemplate[] = [
  {
    key: "invoices",
    label: msg`Chase unpaid invoices`,
    description: msg`Finds overdue invoices and drafts friendly reminders`,
    names: [msg`Invoice chaser`, msg`Payment pal`],
    job: msg`Chases unpaid invoices and drafts the reminders.`,
    instructions: msg`Look for invoices more than 14 days overdue. Draft a short, friendly reminder to each client, in their own language, and say who owes what. Never send anything yourself: leave the drafts for a person to check.`,
  },
  {
    key: "inbox",
    label: msg`Sort the inbox`,
    description: msg`Sorts new mail and drafts replies to what is urgent`,
    names: [msg`Inbox sorter`, msg`Mail desk`],
    job: msg`Sorts new mail and drafts replies to what is urgent.`,
    instructions: msg`Read the new mail and sort each message into urgent, to do or to read, with one sentence on what it is about. Draft a reply to each urgent one, short and polite. Put the urgent ones first.`,
  },
  {
    key: "meetings",
    label: msg`Prepare meetings`,
    description: msg`Gathers what to know before each meeting`,
    names: [msg`Meeting prep`, msg`Briefing desk`],
    job: msg`Gathers what to know before each meeting.`,
    instructions: msg`For each meeting today, say who is coming, what was last agreed with them and what is still open. Keep each meeting to a few lines.`,
  },
  {
    key: "report",
    label: msg`Write the weekly report`,
    description: msg`Sums up the week's work for the team`,
    names: [msg`Weekly reporter`, msg`Week in review`],
    job: msg`Sums up the week's work for the team.`,
    instructions: msg`Sum up what changed this week: what was finished, what is late and what needs a decision. Name the people involved, keep it to one page and end with the three things that matter most.`,
  },
];
