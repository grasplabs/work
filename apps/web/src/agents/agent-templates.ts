import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import {
  AppRecord,
  CalendarIcon,
  Chat,
  Checklist,
  Doc,
  Inbox,
  Measure,
  UserAdd,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";

// The starting points Grasp offers when someone makes an agent
// (manual-agent.tsx, new-agent.tsx): a job most companies have, drawn as
// a small card (its mark, its name, one line, and when it works → what it
// delivers), with the names it suggests and its brief: what it is told,
// in the five parts every agent's instructions have (agent-brief.ts).
// Fixed choices, so constants here; whatever is chosen is only a start,
// and every word of it can be changed before the agent is made.

/** What an agent is told, in the five parts of agent-brief.ts. */
export interface TemplateBrief {
  goal: MessageDescriptor;
  look: readonly MessageDescriptor[];
  steps: readonly MessageDescriptor[];
  rules: readonly MessageDescriptor[];
  deliver: MessageDescriptor;
}

/** One starting point. */
export interface AgentTemplate {
  /** A stable key: what the choice sends. */
  key: string;
  /** Its mark on the card. */
  icon: IconData;
  /** The choice, short. */
  label: MessageDescriptor;
  /** One line under it. */
  description: MessageDescriptor;
  /** When it works, and what it delivers: the card's foot. */
  cadence: MessageDescriptor;
  outcome: MessageDescriptor;
  /**
   * Words in an agent's name that point to this job, lowercase, so the
   * cards a name brings up come first. English, the product's own words.
   */
  keywords: readonly string[];
  /** The names Grasp suggests for it. */
  names: readonly MessageDescriptor[];
  /** What it is for, in one sentence. */
  job: MessageDescriptor;
  /** What it is told. */
  brief: TemplateBrief;
}

export const agentTemplates: readonly AgentTemplate[] = [
  {
    key: "invoices",
    icon: AppRecord,
    label: msg`Chase unpaid invoices`,
    description: msg`Finds overdue invoices and drafts friendly reminders.`,
    cadence: msg`Every weekday`,
    outcome: msg`Draft reminders`,
    keywords: [
      "invoice",
      "payment",
      "pay",
      "debt",
      "chase",
      "finance",
      "money",
      "credit",
      "billing",
    ],
    names: [msg`Invoice chaser`, msg`Payment pal`],
    job: msg`Chases unpaid invoices and drafts the reminders.`,
    brief: {
      goal: msg`Make sure every overdue invoice gets a friendly reminder, so the company is paid on time.`,
      look: [
        msg`Open invoices in the accounting system, with their due dates.`,
        msg`Earlier reminders and replies from the client in the mailbox.`,
      ],
      steps: [
        msg`Find every invoice more than 14 days past its due date.`,
        msg`Skip an invoice that was reminded in the last 7 days, or that the client disputed.`,
        msg`For each one left, draft a short, friendly reminder in the client's own language, with the invoice number, the amount and the due date.`,
        msg`Make a list of what you drafted, the oldest first.`,
      ],
      rules: [
        msg`Never send anything yourself: leave every draft for a person to check.`,
        msg`If an amount or a client is unclear, say so instead of guessing.`,
        msg`If nothing is overdue, say that in one line and stop.`,
      ],
      deliver: msg`One message that starts with "Overdue invoices:", then a line per draft: client, amount, days overdue.`,
    },
  },
  {
    key: "inbox",
    icon: Inbox,
    label: msg`Sort the inbox`,
    description: msg`Sorts new mail and drafts replies to what is urgent.`,
    cadence: msg`Every morning`,
    outcome: msg`Draft replies`,
    keywords: [
      "inbox",
      "mail",
      "email",
      "e-mail",
      "reply",
      "replies",
      "desk",
      "support",
      "sort",
    ],
    names: [msg`Inbox sorter`, msg`Mail desk`],
    job: msg`Sorts new mail and drafts replies to what is urgent.`,
    brief: {
      goal: msg`Turn a full inbox into a short list of what needs a person today.`,
      look: [
        msg`New mail since the last run.`,
        msg`Earlier mail in the same thread.`,
      ],
      steps: [
        msg`Sort each new message into urgent, to do or to read.`,
        msg`Write one sentence on what each message is about.`,
        msg`Draft a short, polite reply to each urgent message.`,
      ],
      rules: [
        msg`Never send a reply yourself: leave the drafts for a person.`,
        msg`Leave newsletters and automatic mail out of the list.`,
        msg`If a message is unclear, put it under to do and say why.`,
      ],
      deliver: msg`One message with the urgent mail first, then to do, then to read, a line each.`,
    },
  },
  {
    key: "meetings",
    icon: CalendarIcon,
    label: msg`Prepare meetings`,
    description: msg`Gathers what to know before each meeting.`,
    cadence: msg`Before meetings`,
    outcome: msg`Brief you`,
    keywords: [
      "meeting",
      "meetings",
      "calendar",
      "brief",
      "briefing",
      "prep",
      "agenda",
    ],
    names: [msg`Meeting prep`, msg`Briefing desk`],
    job: msg`Gathers what to know before each meeting.`,
    brief: {
      goal: msg`Walk into every meeting knowing who is coming and what is still open.`,
      look: [
        msg`Today's meetings in the calendar.`,
        msg`Earlier mail, notes and files about the people and the topic.`,
      ],
      steps: [
        msg`For each meeting today, list who is coming and their role.`,
        msg`Find what was last agreed with them, and what is still open.`,
        msg`Suggest up to three points to raise.`,
      ],
      rules: [
        msg`Keep each meeting to a few lines.`,
        msg`Leave out private calendar items.`,
        msg`If there is nothing on someone, say so instead of guessing.`,
      ],
      deliver: msg`One briefing per meeting, starting with its time and title.`,
    },
  },
  {
    key: "report",
    icon: Measure,
    label: msg`Write the weekly report`,
    description: msg`Sums up the week's work for the team.`,
    cadence: msg`Every Friday`,
    outcome: msg`Share the report`,
    keywords: [
      "report",
      "weekly",
      "week",
      "summary",
      "review",
      "wrap",
      "update",
    ],
    names: [msg`Weekly reporter`, msg`Week in review`],
    job: msg`Sums up the week's work for the team.`,
    brief: {
      goal: msg`Give the team one page on what happened this week and what needs a decision.`,
      look: [
        msg`What was finished, changed or started this week, in the team's apps and files.`,
        msg`Decisions and open questions in mail and chats.`,
      ],
      steps: [
        msg`List what was finished, and who did it.`,
        msg`List what is late, and why if it is known.`,
        msg`List what needs a decision, and from whom.`,
        msg`Pick the three things that matter most.`,
      ],
      rules: [
        msg`Keep it to one page.`,
        msg`Name people only for what they did, never to blame.`,
        msg`If a week was quiet, say so in a short report.`,
      ],
      deliver: msg`A report with four parts: Done, Late, Needs a decision, and The three things that matter most.`,
    },
  },
  {
    key: "questions",
    icon: Chat,
    label: msg`Answer team questions`,
    description: msg`Answers questions from what the company knows.`,
    cadence: msg`When asked`,
    outcome: msg`Answer with sources`,
    keywords: [
      "question",
      "questions",
      "answer",
      "help",
      "helpdesk",
      "faq",
      "knowledge",
      "assistant",
    ],
    names: [msg`Help desk`, msg`Ask the team`],
    job: msg`Answers the team's questions from what the company knows.`,
    brief: {
      goal: msg`Give people a correct answer quickly, so they don't have to search or ask around.`,
      look: [
        msg`The company's documents and knowledge.`,
        msg`Earlier answers to the same question.`,
      ],
      steps: [
        msg`Find the parts of the company's knowledge that answer the question.`,
        msg`Answer in a few sentences, in plain words.`,
        msg`Name where the answer comes from.`,
      ],
      rules: [
        msg`If you can't find the answer, say so and say who might know.`,
        msg`Never make up a policy, a number or a date.`,
      ],
      deliver: msg`A short answer, then its sources.`,
    },
  },
  {
    key: "leads",
    icon: UserAdd,
    label: msg`Follow up on leads`,
    description: msg`Spots leads gone quiet and drafts a follow-up.`,
    cadence: msg`Every weekday`,
    outcome: msg`Draft follow-ups`,
    keywords: [
      "lead",
      "leads",
      "sales",
      "prospect",
      "deal",
      "crm",
      "follow",
      "customer",
      "client",
    ],
    names: [msg`Lead follow-up`, msg`Deal keeper`],
    job: msg`Spots leads that went quiet and drafts a follow-up.`,
    brief: {
      goal: msg`Make sure no lead goes quiet without a follow-up.`,
      look: [
        msg`Open leads and deals in the CRM.`,
        msg`The last mail with each lead.`,
      ],
      steps: [
        msg`Find leads with no contact in the last 7 days.`,
        msg`For each one, draft a short follow-up that picks up where the last message ended.`,
        msg`List them, the most valuable first.`,
      ],
      rules: [
        msg`Never send anything yourself: leave the drafts for a person.`,
        msg`Skip leads marked lost or not interested.`,
      ],
      deliver: msg`One message that starts with "Leads to follow up:", then a line per draft: name, company, days quiet.`,
    },
  },
  {
    key: "documents",
    icon: Doc,
    label: msg`Summarise documents`,
    description: msg`Turns long documents into the points that matter.`,
    cadence: msg`When asked`,
    outcome: msg`Write a summary`,
    keywords: [
      "document",
      "documents",
      "doc",
      "docs",
      "summary",
      "summarise",
      "summarize",
      "contract",
      "read",
    ],
    names: [msg`Summary writer`, msg`Doc reader`],
    job: msg`Turns long documents into the points that matter.`,
    brief: {
      goal: msg`Let someone understand a long document in two minutes.`,
      look: [msg`The document someone shares or names.`],
      steps: [
        msg`Read the whole document.`,
        msg`Pick out the main points, the decisions and the deadlines.`,
        msg`Note anything unusual or risky.`,
      ],
      rules: [
        msg`Quote the document's own words for numbers and dates.`,
        msg`If a part is unreadable, say which part.`,
      ],
      deliver: msg`A summary of at most ten lines, then deadlines and risks, each as a list.`,
    },
  },
  {
    key: "day",
    icon: Checklist,
    label: msg`Plan the day`,
    description: msg`Lists what matters today from mail, tasks and calendar.`,
    cadence: msg`Every morning`,
    outcome: msg`Send the plan`,
    keywords: [
      "plan",
      "planner",
      "day",
      "daily",
      "task",
      "tasks",
      "todo",
      "agenda",
      "focus",
      "morning",
    ],
    names: [msg`Day planner`, msg`Morning brief`],
    job: msg`Lists what matters today from mail, tasks and the calendar.`,
    brief: {
      goal: msg`Start each day knowing the few things that matter most.`,
      look: [
        msg`Today's calendar.`,
        msg`Open tasks and their due dates.`,
        msg`Mail that asks for something.`,
      ],
      steps: [
        msg`List today's meetings with their times.`,
        msg`List tasks due today or overdue.`,
        msg`Pick the three things that matter most, and say why.`,
      ],
      rules: [
        msg`Keep it short enough to read in a minute.`,
        msg`If the day is empty, say so.`,
      ],
      deliver: msg`One message: The three things first, then meetings, then tasks.`,
    },
  },
];

const wordBreak = /[^\p{L}\p{N}]+/u;

/** A word long enough to point anywhere: "a" or "my" would match too much. */
const shortest = 3;

/** The starting points that suit a name best first: those whose words the name has. */
export const templatesFor = (name: string): readonly AgentTemplate[] => {
  const words = name
    .toLowerCase()
    .split(wordBreak)
    .filter((word) => word.length >= shortest);
  const score = (template: AgentTemplate) =>
    template.keywords.filter((keyword) =>
      words.some((word) => word.startsWith(keyword) || keyword.startsWith(word))
    ).length;
  // A stable sort: equal scores keep the order above.
  return agentTemplates.toSorted((a, b) => score(b) - score(a));
};
