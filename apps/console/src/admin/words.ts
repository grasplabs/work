/**
 * The admin's words for where an organization stands and what needs Grasp
 * there, in English, ported from the prototype (grasplabs/prototype
 * `components/admin/admin-words.ts`, `stage-lines.ts`, `need-lines.ts` and
 * `account-words.ts`). They say what the model worked out (`AdminView`)
 * and nothing more: numbers, days, and names (the company's, its teams',
 * its leads' and its works'), never anything someone wrote or said.
 */
import type { AdminPhase } from "@grasp-os/shared/admin/admin-health";
import { VISION_FIELDS } from "@grasp-os/shared/admin/interviews";
import {
  dateOn,
  listenDays,
  mayInvite,
} from "@grasp-os/shared/admin/onboarding-admin";
import type {
  ContractState,
  KnowledgeSource,
  Need,
  OrgView,
  Settler,
  Stage,
} from "@grasp-os/shared/admin/onboarding-admin";

const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The parts of an ISO day, "2026-09-02". */
const partsOf = (iso: string): { year: string; month: string; day: number } => {
  const [year = "", month = "", day = ""] = iso.slice(0, 10).split("-");
  return {
    year,
    month: months[Number(month) - 1] ?? "",
    day: Number(day),
  };
};

/** "2026-09-02" as "2 Sep 2026". */
export const formatDate = (iso: string): string => {
  const { year, month, day } = partsOf(iso);
  return `${day} ${month} ${year}`;
};

/** "2026-09" as "Sep 2026". */
const formatMonth = (iso: string): string => {
  const { year, month } = partsOf(`${iso}-01`);
  return `${month} ${year}`;
};

const wholeEuros = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const euroCents = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const wholeNumber = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

/** A fee or a value: always in whole euros. */
export const euros = (amount: number): string => wholeEuros.format(amount);

/** An amount in euros: to the cent while it is small, in whole euros from ten on. */
export const euro = (amount: number): string =>
  amount >= 10 ? euros(amount) : euroCents.format(amount);

/** Hours and the like, as whole numbers. */
export const whole = (value: number): string => wholeNumber.format(value);

/** "a, b and c". */
export const formatList = (items: string[]): string =>
  new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(
    items
  );

/** One for one, many for the rest: `${count} ${plural(count, "thing", "things")}`. */
const plural = (count: number, one: string, other: string): string =>
  count === 1 ? one : other;

/** The steps of an onboarding. */
export const stageWords: Record<Stage, string> = {
  conversation: "First conversation",
  research: "Research",
  agreed: "Agreed",
  connected: "Connected",
  leads: "Team leads",
  interviews: "Interviews",
  open: "Grasp opens",
};

/** The phases the list of organizations is cut into. */
export const phaseWords: Record<AdminPhase, string> = {
  start: "Starting",
  agreements: "Agreements",
  interviews: "Interviews",
  ready: "Ready",
  open: "Open",
};

/** What each source of what Grasp knows about a company is (`knowledge-words.ts`). */
export const knowledgeWords: Record<KnowledgeSource, string> = {
  vision: "The first conversation and the research",
  directory: "Who works where, from the sign-in",
  sources: "Where the documents live, connected",
  documents: "Documents dropped in",
  pulse: "Pulse",
  leadsKnown: "Team leads, from the HR platform",
  leadsHeard: "Team leads interviewed",
  everyoneHeard: "Everyone else interviewed",
  review: "Workflows known",
};

/** Where a contract stands. */
export const contractWords: Record<ContractState, string> = {
  draft: "Being written",
  sent: "Sent, not signed",
  signed: "Signed",
};

/** How many things the first conversation left open, to ask the sponsor. */
const missingOf = (view: OrgView): number => {
  const { vision } = view;
  return vision === null
    ? 0
    : VISION_FIELDS.filter((field) => !vision.fields[field]).length;
};

const conversationLine = (view: OrgView): string => {
  const { conversation } = view.state;
  if (conversation === "none") {
    return "Not brought in yet";
  }
  if (conversation === "in") {
    return "Brought in, not read yet";
  }
  const missing = missingOf(view);
  return missing > 0
    ? `Read. ${missing} ${plural(missing, "thing", "things")} to ask the sponsor`
    : "Read, nothing is missing";
};

const researchLine = (view: OrgView): string => {
  const { org, state } = view;
  if (state.research === "done") {
    return org.research.some((finding) => (finding.conflict ?? "") !== "")
      ? "Done. Two sources disagree"
      : "Done";
  }
  return org.made === true
    ? "Not run for an organization made here"
    : "Not started";
};

const agreedLine = (view: OrgView): string => {
  const { agreed } = view.state;
  if (mayInvite(agreed)) {
    return "Everything is in place";
  }
  return agreed.council === "waiting"
    ? "The works council is still deciding"
    : "Not signed yet";
};

const connectedLine = (view: OrgView): string => {
  const { client } = view.state;
  if (client === "none") {
    return "Waits on the company’s own admin";
  }
  return client === "directory"
    ? "Sign-in connected, team leads not named yet"
    : "Sign-in connected, team leads named";
};

const leadsLine = (view: OrgView): string => {
  if (!view.told) {
    return "They get their link when the team is told";
  }
  const taking = view.teams.filter((team) => !team.off);
  // Heard, not sent: a team's links can go out without its lead.
  const leads = taking.filter((team) => team.heard !== null).length;
  return `${leads} of ${taking.length} talked`;
};

const interviewsLine = (view: OrgView): string => {
  const talked = view.counts.completed;
  const days = listenDays(view.org);
  if (view.closed) {
    return `Closed. ${talked} of ${view.asked} talked`;
  }
  return view.told
    ? `Day ${view.day} of ${days}. ${talked} of ${view.asked} talked`
    : `${days === 14 ? "Two weeks" : `${days} days`}, from the day the team is told`;
};

const openLine = (view: OrgView): string => {
  const { percent, threshold, opened, ready } = view.knowledge;
  if (opened !== null) {
    return `Open since ${formatDate(dateOn(view.org, opened))}`;
  }
  return ready
    ? `${percent}% known. Ready for Grasp’s go`
    : `${percent}% known. It opens at ${threshold}%`;
};

/** Where each step of an onboarding stands, in one line. */
export const stageLines = (view: OrgView): Record<Stage, string> => ({
  conversation: conversationLine(view),
  research: researchLine(view),
  agreed: agreedLine(view),
  connected: connectedLine(view),
  leads: leadsLine(view),
  interviews: interviewsLine(view),
  open: openLine(view),
});

const agreementLines: Record<
  Extract<Need, { kind: "agreement" }>["what"],
  string
> = {
  processing: "The agreement on handling data is not signed yet.",
  assessment: "The company has not signed off its look at the risks yet.",
  council:
    "The works council is still deciding. Until it says yes, nobody is invited.",
};

const waitsOn: Record<Settler, string> = {
  owner: "the owner of the workflow",
  lead: "the team lead",
  sponsor: "the sponsor",
};

const endingLine = (until: string, days: number): string => {
  const on = formatDate(until);
  if (days === 0) {
    return `The contract ends today, on ${on}. Nothing is agreed for after.`;
  }
  if (days === 1) {
    return `The contract ends tomorrow, on ${on}. Nothing is agreed for after.`;
  }
  return `The contract ends in ${days} days, on ${on}. Nothing is agreed for after.`;
};

/**
 * What needs someone at Grasp, said in a sentence. A finding the research
 * turned up is said without its words: they are free text, and the
 * overview shows only what the model counts and names.
 */
// oxlint-disable-next-line complexity -- one line for each kind of need, as the prototype has them.
export const needLine = (need: Need, view: OrgView): string => {
  switch (need.kind) {
    case "paused": {
      return "The interviews are paused: nobody can open or finish theirs until Grasp resumes them.";
    }
    case "transcript": {
      return view.state.conversation === "in"
        ? "The first conversation is in. Have Stephen read it."
        : "Bring in the first conversation with the sponsor.";
    }
    case "ask": {
      const count = need.fields.length;
      return `The first conversation left ${count} ${plural(count, "thing", "things")} open. Ask the sponsor.`;
    }
    case "research": {
      return "Stephen has read the first conversation. Start the research.";
    }
    case "conflict": {
      return "Two sources disagree about the company. The company’s own account wins, so this goes to its admin.";
    }
    case "agreement": {
      return agreementLines[need.what];
    }
    case "lead": {
      return `${need.lead} has not talked yet, so ${need.team.name} has no links. A word from the sponsor helps.`;
    }
    case "quiet": {
      const closes = need.left === 1 ? "tomorrow" : `in ${need.left} days`;
      return `${need.team.name}: only ${need.talked} have talked, and the link closes ${closes}.`;
    }
    case "blocked": {
      return `${need.work.name}: people describe a step in two ways, and nobody can say why. It waits on ${waitsOn[view.state.rules.settles]}.`;
    }
    case "split": {
      return `${need.work.name}: so many interviews without settling that it is probably two workflows. Ask ${need.lead} to split it.`;
    }
    case "few": {
      const count = need.works.length;
      return count === 1
        ? "1 piece of work was heard from too few people before the link closed."
        : `${count} pieces of work were heard from too few people before the link closed.`;
    }
    case "go": {
      return `${need.percent}% of what Grasp needs is known: enough to open at ${need.threshold}%. The company comes in once Grasp gives its go.`;
    }
    case "short": {
      return `The interviews are over at ${need.percent}%, below the ${need.threshold}% it opens at. Decide whether to open it with what is still open shown.`;
    }
    case "contract": {
      return need.sent === null
        ? "The contract is still being written."
        : `The contract was sent on ${formatDate(need.sent)} and is not signed yet.`;
    }
    case "ending": {
      return endingLine(need.until, need.days);
    }
    case "signin": {
      return `${need.integration.name} stopped working until someone at the company signs in again. Ask its admin.`;
    }
    case "budget": {
      return `AI use came to ${euros(need.spend)} in ${formatMonth(need.month)}, above the ${euros(need.included)} a month the contract covers.`;
    }
    case "read": {
      return need.count === 1
        ? "1 interview waits to be read by a person at Grasp."
        : `${need.count} interviews wait to be read by a person at Grasp.`;
    }
    default: {
      return need satisfies never;
    }
  }
};
