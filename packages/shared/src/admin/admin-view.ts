import {
  agreementsOf,
  companyOf,
  contactsOf,
  contractOf,
  integrationsOf,
  invoicesOf,
  membersOf,
  monthOf,
  seatsOf,
} from "./admin-account.ts";
import type {
  AdminInvoice,
  AgreementView,
  ContractView,
  IntegrationView,
  MemberView,
} from "./admin-account.ts";
import { asOf, isOpen, usageOf, valueOf } from "./admin-usage.ts";
import type { Usage, Use, Value } from "./admin-usage.ts";
import { logOf } from "./onboarding-admin-record.ts";
import type { LogEvent } from "./onboarding-admin-record.ts";
import { viewOf } from "./onboarding-admin.ts";
import type {
  Agreed,
  Company,
  Contact,
  ContactRole,
  Need,
  Org,
  OrgState,
  OrgView,
  Unknown,
} from "./onboarding-admin.ts";
import { present } from "./present.ts";

/**
 * Everything the admin shows about one organization on one day: its onboarding, and around it the
 * company itself, its contract, who is in its platform, what it connected, what it costs in AI and
 * what its work is worth in hours. And across organizations: what they add up to. Pure.
 */
export interface AdminView extends OrgView {
  /** The day everything is counted up to. */
  asOf: string;
  /** Grasp is open for the company. */
  open: boolean;
  company: Company;
  contacts: Partial<Record<ContactRole, Contact>>;
  contract: ContractView;
  invoices: AdminInvoice[];
  agreements: AgreementView[];
  members: MemberView[];
  seats: { used: number; of: number };
  integrations: IntegrationView[];
  usage: Usage;
  value: Value;
  /** What isn't known of the company yet: its contract and its work read as unknown, not as a draft or as none. */
  unknown: Unknown;
}

/**
 * What needs Grasp first: interviews it paused, as nobody gets on until it resumes them, then a
 * go to give, then what holds people up, then the first conversation
 * that Stephen prepares from, then what can wait a day.
 */
const NEED_ORDER: Need["kind"][] = [
  "paused",
  "go",
  "short",
  "ending",
  "blocked",
  "lead",
  "quiet",
  "transcript",
  "agreement",
  "contract",
  "conflict",
  "research",
  "ask",
  "budget",
  "signin",
  "split",
  "few",
  "read",
];

const byUrgency = (a: Need, b: Need) =>
  NEED_ORDER.indexOf(a.kind) - NEED_ORDER.indexOf(b.kind);

export const adminViewOf = (
  org: Org,
  state: OrgState,
  today: string
): AdminView => {
  const view = viewOf(org, state);
  const day = asOf(view, today);
  const open = isOpen(view);
  const contract = contractOf(org, state, day);
  const members = membersOf(view, day, open);
  const integrations = integrationsOf(view, day);
  const usage = usageOf(view, day, members);

  // What the company itself brings to Grasp's table, beside its onboarding.
  const needs: Need[] = [...view.needs];
  const unknown = org.real?.unknown ?? { contract: false, works: false };
  // A contract nobody has told the admin of yet is not one waiting to be signed.
  if (contract.status !== "signed" && !unknown.contract) {
    needs.push({
      kind: "contract",
      sent: contract.status === "sent" ? (contract.sent ?? null) : null,
    });
  }
  if (contract.ending) {
    needs.push({
      kind: "ending",
      until: contract.until,
      days: contract.daysLeft,
    });
  }
  for (const integration of integrations) {
    if (integration.again && integration.asked === null) {
      needs.push({ kind: "signin", integration });
    }
  }
  // More AI than the contract covers: in the month that is running, or else in the last one that is over.
  if (contract.status === "signed" && contract.aiIncluded > 0) {
    let over: { month: string; use: Use } | null = null;
    if (usage.thisMonth.spend > contract.aiIncluded) {
      over = { month: monthOf(day), use: usage.thisMonth };
    } else if (
      usage.lastMonth &&
      usage.lastMonth.use.spend > contract.aiIncluded
    ) {
      over = usage.lastMonth;
    }
    if (over) {
      needs.push({
        kind: "budget",
        month: over.month,
        spend: over.use.spend,
        included: contract.aiIncluded,
      });
    }
  }

  return {
    ...view,
    needs: needs.toSorted(byUrgency),
    asOf: day,
    open,
    company: companyOf(org, state),
    contacts: contactsOf(org, state),
    contract,
    invoices: invoicesOf(org, contract, day),
    agreements: agreementsOf(org, state),
    members,
    seats: seatsOf(members, contract),
    integrations,
    usage,
    value: valueOf(view, day),
    unknown,
  };
};

/** Something that happened at a company around its interviews: on its contract, its agreements and its platform. */
export type AccountEvent = { on: string } & (
  | { kind: "contractSent" }
  | { kind: "contractSigned" }
  | { kind: "contractStarts" }
  | { kind: "agreement"; paper: keyof Agreed }
  | { kind: "connected"; name: string }
  /** People invited into the platform that day. */
  | { kind: "invited"; count: number }
  /** People who made their account that day. */
  | { kind: "joined"; count: number }
  /** A workflow went live. */
  | { kind: "live"; work: string }
);

/** How things that happened on the same day follow each other, the latest first. */
const HISTORY_ORDER: (LogEvent | AccountEvent)["kind"][] = [
  "live",
  "closed",
  "go",
  "talked",
  "reminded",
  "lead",
  "told",
  "joined",
  "invited",
  "connected",
  "contractStarts",
  "agreement",
  "conversation",
  "contractSigned",
  "contractSent",
];

/**
 * Everything that happened at a company so far, the newest first: its interviews day by day, and
 * around them the contract, the agreements, what it connected, who was invited and came in, and
 * each workflow going live.
 */
export const historyOf = (view: AdminView): (LogEvent | AccountEvent)[] => {
  const { org, contract } = view;
  const events: (LogEvent | AccountEvent)[] = [...logOf(view)];
  const add = (event: AccountEvent) => {
    if (event.on <= view.asOf) {
      events.push(event);
    }
  };
  if (present(contract.sent)) {
    add({ kind: "contractSent", on: contract.sent });
  }
  if (contract.status === "signed" && present(contract.signed)) {
    add({ kind: "contractSigned", on: contract.signed });
    add({ kind: "contractStarts", on: contract.from });
  }
  for (const agreement of view.agreements) {
    if (agreement.state === "signed" && present(agreement.on)) {
      add({ kind: "agreement", on: agreement.on, paper: agreement.what });
    }
  }
  for (const integration of view.integrations) {
    add({ kind: "connected", on: integration.since, name: integration.name });
  }
  const members = view.members.filter((member) => member.state !== "removed");
  for (const [kind, of] of [
    ["invited", (member: (typeof members)[number]) => member.invited],
    ["joined", (member: (typeof members)[number]) => member.joined],
  ] as const) {
    const days = new Map<string, number>();
    for (const member of members) {
      const on = of(member);
      if (present(on)) {
        days.set(on, (days.get(on) ?? 0) + 1);
      }
    }
    for (const [on, count] of days) {
      add({ kind, on, count });
    }
  }
  for (const work of view.value.works) {
    if (work.live && present(work.run?.since)) {
      add({
        kind: "live",
        on: work.run.since,
        work:
          org.works.find((each) => each.id === work.evidence.id)?.name ??
          work.evidence.id,
      });
    }
  }
  return events.toSorted(
    (a, b) =>
      b.on.localeCompare(a.on) ||
      HISTORY_ORDER.indexOf(a.kind) - HISTORY_ORDER.indexOf(b.kind)
  );
};

/** Every organization together. */
export interface Portfolio {
  orgs: number;
  /** Enough is known, and they wait for Grasp's go. */
  ready: number;
  /** Grasp is open for them. */
  open: number;
  /** What the contracts that run today bring a month, in euros before VAT. */
  fees: number;
  /** AI used this month, in euros. */
  spend: number;
  /** Hours a week freed in live workflows, and what they are worth a month. */
  freed: number;
  value: number;
  /** How many of them the fees, and the hours and their worth, are counted from: not those whose contract or work isn't known yet. */
  counted: { fees: number; value: number };
}

export const portfolioOf = (views: AdminView[]): Portfolio => {
  const sum = (of: (view: AdminView) => number) =>
    views.reduce((total, view) => total + of(view), 0);
  return {
    orgs: views.length,
    ready: views.filter((view) => view.knowledge.ready && !view.open).length,
    open: views.filter((view) => view.open).length,
    fees: sum((view) => (view.contract.running ? view.contract.fee : 0)),
    spend: sum((view) => view.usage.thisMonth.spend),
    freed: sum((view) => view.value.freed),
    value: sum((view) => view.value.value),
    counted: {
      fees: views.filter((view) => !view.unknown.contract).length,
      value: views.filter((view) => !view.unknown.works).length,
    },
  };
};
