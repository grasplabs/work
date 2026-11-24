/**
 * What the admin has on one organization, as the entries of its column,
 * ported from the prototype (grasplabs/prototype
 * `components/admin/admin-sections.ts` and the sections' words in
 * `account-words.ts`): an overview first, then the company itself, its
 * onboarding, how it uses the platform, and the record of it all.
 *
 * And where each section's figures come from (as the prototype's
 * `lib/admin-sources.ts` had it under each title), read off what the
 * company's core answered: its own Grasp for what it holds, this admin
 * for its platform, Grasp's Stripe for its billing once it is linked to a
 * customer there, and for what core doesn't hold yet (its contacts, its
 * contract, its drawn work, its integrations) the outside system that
 * brings it, not read yet.
 */
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import type { Need } from "@grasp-os/shared/admin/onboarding-admin";
import {
  BrainIcon,
  Building2Icon,
  CoinsIcon,
  HistoryIcon,
  HourglassIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  PlugIcon,
  ServerIcon,
  WorkflowIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Every section, in the column's order. */
export const orgSections = [
  "overview",
  "details",
  "steps",
  "interviews",
  "workflows",
  "setup",
  "integrations",
  "usage",
  "value",
  "brain",
  "log",
] as const;
export type OrgSection = (typeof orgSections)[number];

/** The column's groups, in order. The overview stands above them, on its own. */
export const sectionGroups = [
  { id: "company", label: "Company", sections: ["details"] },
  {
    id: "onboarding",
    label: "Onboarding",
    sections: ["steps", "interviews", "workflows"],
  },
  {
    id: "platform",
    label: "Platform",
    sections: ["setup", "integrations", "usage", "value"],
  },
  { id: "records", label: "Records", sections: ["brain", "log"] },
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
  overview: "/organizations/$clientId",
  details: "/organizations/$clientId/details",
  steps: "/organizations/$clientId/steps",
  interviews: "/organizations/$clientId/interviews",
  workflows: "/organizations/$clientId/workflows",
  setup: "/organizations/$clientId/setup",
  integrations: "/organizations/$clientId/integrations",
  usage: "/organizations/$clientId/ai-use",
  value: "/organizations/$clientId/hours",
  brain: "/organizations/$clientId/brain",
  log: "/organizations/$clientId/log",
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
      "The company as its own papers have it, who Grasp deals with there, its contract and its members.",
    icon: Building2Icon,
  },
  steps: {
    title: "Steps",
    about:
      "From the first conversation until Grasp opens, and how much of that onboarding this company goes through.",
    icon: ListChecksIcon,
  },
  interviews: {
    title: "Interviews",
    about:
      "Where every team stands, everyone by name, and how Stephen and Claire did.",
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
      "What the company’s brain stands on and how it runs, and what Grasp keeps of the interviews.",
    icon: BrainIcon,
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
  conflict: "steps",
  agreement: "steps",
  lead: "steps",
  quiet: "steps",
  go: "steps",
  short: "steps",
  blocked: "workflows",
  split: "workflows",
  few: "workflows",
  contract: "details",
  ending: "details",
  overdue: "details",
  signin: "integrations",
  budget: "usage",
  read: "interviews",
};

export const needSection = (need: Need): OrgSection => needSections[need.kind];

/**
 * Where a need is settled: its section, and the tab of it where that isn't
 * the section's first. The contract's are on Details' Contract.
 */
export const needWhere = (
  need: Need
): { section: OrgSection; search: { tab: "contract" } | undefined } => ({
  section: needSection(need),
  search:
    need.kind === "contract" ||
    need.kind === "ending" ||
    need.kind === "overdue"
      ? { tab: "contract" }
      : undefined,
});

/** A system a section's figures come from. */
export type OrgSource = "core" | "admin" | "attio" | "stripe" | "composio";

/** Each source by name, as a section's line says it. */
export const sourceNames: Record<OrgSource, string> = {
  core: "the company’s own Grasp",
  admin: "this admin",
  attio: "Attio",
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
 * admin's own: the deploys and releases it runs for the company.
 */
export const originsOf = (
  snapshot: AdminSnapshot,
  /** Stripe was read for the company now. */
  stripe: boolean,
  /** Attio was read for the company now. */
  attio = false
): Record<OrgSection, Origin[]> => {
  const contacts = snapshot.contacts !== null;
  const works = snapshot.works !== null;
  const integrations = snapshot.integrations !== null;
  return {
    overview: [fromCore],
    details: [
      fromCore,
      { source: "attio", what: "Who Grasp deals with there", read: contacts },
      {
        source: "attio",
        what: "The company, its people and its deals",
        read: attio,
      },
      { source: "stripe", what: "Its billing and invoices", read: stripe },
    ],
    steps: [fromCore],
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
        read: integrations,
      },
    ],
    setup: [{ source: "admin", read: true }],
    integrations: [
      {
        source: "core",
        what: "What the company connected",
        read: integrations,
      },
      {
        source: "composio",
        what: "What its workflows still need connected",
        read: integrations,
      },
    ],
    usage: [fromCore],
    value: [
      { source: "core", what: "The hours in the drawn work", read: works },
    ],
    brain: [fromCore],
    log: [fromCore],
  };
};
