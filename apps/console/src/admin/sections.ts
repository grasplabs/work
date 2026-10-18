/**
 * What the admin has on one organization, as the entries of its column,
 * ported from the prototype (grasplabs/prototype
 * `components/admin/admin-sections.ts` and the sections' words in
 * `account-words.ts`): an overview first, then the company itself, its
 * onboarding, how it uses the platform, and the record of it all.
 *
 * And where each section's figures come from (as the prototype's
 * `lib/admin-sources.ts` had it under each title), read off what the
 * company's core answered: its own Grasp for what it holds, this console
 * for its platform, and for what core doesn't hold yet (its contacts, its
 * contract, its drawn work, its integrations) the outside system that
 * brings it, not read yet.
 */
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import type { Need } from "@grasp-os/shared/admin/onboarding-admin";
import {
  BrainIcon,
  Building2Icon,
  CoinsIcon,
  DatabaseIcon,
  FileSignatureIcon,
  HistoryIcon,
  HourglassIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  NetworkIcon,
  PlugIcon,
  ServerIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Every section, in the column's order. */
export const orgSections = [
  "overview",
  "details",
  "contract",
  "members",
  "steps",
  "organization",
  "interviews",
  "workflows",
  "setup",
  "integrations",
  "usage",
  "value",
  "brain",
  "data",
  "log",
] as const;
export type OrgSection = (typeof orgSections)[number];

/** The column's groups, in order. The overview stands above them, on its own. */
export const sectionGroups = [
  {
    id: "company",
    label: "Company",
    sections: ["details", "contract", "members"],
  },
  {
    id: "onboarding",
    label: "Onboarding",
    sections: ["steps", "organization", "interviews", "workflows"],
  },
  {
    id: "platform",
    label: "Platform",
    sections: ["setup", "integrations", "usage", "value"],
  },
  { id: "records", label: "Records", sections: ["brain", "data", "log"] },
] as const satisfies readonly {
  id: string;
  label: string;
  sections: readonly OrgSection[];
}[];

/**
 * Where each section is, under the organization's own path. The sections
 * the prototype calls `usage` and `value` are named as their titles say.
 */
export const sectionTo = {
  overview: "/admin/organizations/$clientId",
  details: "/admin/organizations/$clientId/details",
  contract: "/admin/organizations/$clientId/contract",
  members: "/admin/organizations/$clientId/members",
  steps: "/admin/organizations/$clientId/steps",
  organization: "/admin/organizations/$clientId/organization",
  interviews: "/admin/organizations/$clientId/interviews",
  workflows: "/admin/organizations/$clientId/workflows",
  setup: "/admin/organizations/$clientId/setup",
  integrations: "/admin/organizations/$clientId/integrations",
  usage: "/admin/organizations/$clientId/ai-use",
  value: "/admin/organizations/$clientId/hours",
  brain: "/admin/organizations/$clientId/brain",
  data: "/admin/organizations/$clientId/data",
  log: "/admin/organizations/$clientId/log",
} as const satisfies Record<OrgSection, string>;

/** Each section's title, what it is for in one line under it, and its icon, so the folded column still says which is which. */
export const sectionWords: Record<
  OrgSection,
  { title: string; about: string; icon: LucideIcon }
> = {
  overview: { title: "Overview", about: "", icon: LayoutDashboardIcon },
  details: {
    title: "Details",
    about:
      "The company as its own papers have it, and who Grasp deals with there.",
    icon: Building2Icon,
  },
  contract: {
    title: "Contract",
    about: "What was signed, what it gives the company, and what is billed.",
    icon: FileSignatureIcon,
  },
  members: {
    title: "Members",
    about:
      "Everyone invited into the company’s platform, and what each may do.",
    icon: UsersIcon,
  },
  steps: {
    title: "Steps",
    about:
      "From the first conversation until Grasp opens. Each step opens underneath, with everything that can be done there.",
    icon: ListChecksIcon,
  },
  organization: {
    title: "Organization",
    about:
      "The company as Grasp knows it: its teams, who leads them, who is in them, and the work they do.",
    icon: NetworkIcon,
  },
  interviews: {
    title: "Interviews",
    about:
      "Where every team stands, everyone by name, what was said, and how Stephen and Claire did.",
    icon: MessagesSquareIcon,
  },
  workflows: {
    title: "Workflows",
    about: "How far each piece of work is known, and the rules that decide it.",
    icon: WorkflowIcon,
  },
  setup: {
    title: "Setup",
    about:
      "The company’s own Grasp: what is in place for it, from the contract to its platform.",
    icon: ServerIcon,
  },
  integrations: {
    title: "Integrations",
    about:
      "What the company connected, who connected it, and what Grasp may do there.",
    icon: PlugIcon,
  },
  usage: {
    title: "AI use",
    about: "What this company takes in AI, and what that costs Grasp.",
    icon: CoinsIcon,
  },
  value: {
    title: "Hours",
    about:
      "The hours in the work that is known, and what the workflows free of them.",
    icon: HourglassIcon,
  },
  brain: {
    title: "Brain",
    about:
      "What the company’s brain stands on, team by team, and what it still lacks; and the brain itself, as the company’s people see it, where the company shares it with Grasp’s staff.",
    icon: BrainIcon,
  },
  data: {
    title: "Data",
    about:
      "What Grasp keeps of the interviews, what was deleted, and what the company itself gets to see.",
    icon: DatabaseIcon,
  },
  log: {
    title: "Log",
    about:
      "Everything that happened here, and everything a person at Grasp did by hand.",
    icon: HistoryIcon,
  },
};

/**
 * The section each thing that needs Grasp is settled in, as the
 * prototype's need lines go there (`need-lines.ts`): the column marks it.
 */
const needSections: Record<Need["kind"], OrgSection> = {
  paused: "steps",
  transcript: "steps",
  ask: "steps",
  research: "steps",
  conflict: "steps",
  agreement: "steps",
  lead: "steps",
  quiet: "steps",
  go: "steps",
  short: "steps",
  blocked: "workflows",
  split: "workflows",
  few: "workflows",
  contract: "contract",
  ending: "contract",
  signin: "integrations",
  budget: "usage",
  read: "interviews",
};

export const needSection = (need: Need): OrgSection => needSections[need.kind];

/** A system a section's figures come from. */
export type OrgSource =
  | "core"
  | "console"
  | "attio"
  | "rooms"
  | "stripe"
  | "composio";

/** Each source by name, as a section's line says it. */
export const sourceNames: Record<OrgSource, string> = {
  core: "the company’s own Grasp",
  console: "this console",
  attio: "Attio",
  rooms: "Rooms",
  stripe: "Stripe",
  composio: "Composio",
};

/** One part of a section, where it comes from, and whether that is read now. */
export interface Origin {
  source: OrgSource;
  /** What of the section it brings, when it is one part of several; said where it isn't read yet. */
  what?: string;
  read: boolean;
}

/** What only the company's own Grasp holds, read whenever its core answered. */
const fromCore: Origin = { source: "core", read: true };

/**
 * Where each section's figures come from, as the core that answered holds
 * them: a part core doesn't hold yet (its snapshot has it as null) is
 * still to come from the system that brings it. The setup is this
 * console's own: the deploys and releases it runs for the company.
 */
export const originsOf = (
  snapshot: AdminSnapshot
): Record<OrgSection, Origin[]> => {
  const contacts = snapshot.contacts !== null;
  const contract = snapshot.contract !== null;
  const works = snapshot.works !== null;
  const integrations = snapshot.integrations !== null;
  return {
    overview: [fromCore],
    details: [
      fromCore,
      { source: "attio", what: "Who Grasp deals with there", read: contacts },
    ],
    contract: [
      { source: "rooms", what: "The contract", read: contract },
      { source: "stripe", what: "Its invoices", read: contract },
    ],
    members: [fromCore],
    steps: [fromCore],
    organization: [fromCore],
    interviews: [fromCore],
    workflows: [
      {
        source: "core",
        what: "The work drawn from the interviews",
        read: works,
      },
      {
        source: "composio",
        what: "What its workflows still need connected",
        read: false,
      },
    ],
    setup: [{ source: "console", read: true }],
    integrations: [
      {
        source: "core",
        what: "What the company connected",
        read: integrations,
      },
    ],
    usage: [fromCore],
    value: [
      { source: "core", what: "The hours in the drawn work", read: works },
    ],
    brain: [fromCore],
    data: [fromCore],
    log: [fromCore],
  };
};
