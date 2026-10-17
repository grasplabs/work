import type {
  Agreed,
  Company,
  MemberRole,
  Contact,
  ContactRole,
  Contract,
  Integration,
  Member,
  Org,
  OrgState,
  OrgView,
} from "./onboarding-admin.ts";
import { daysBetween } from "./org-record.ts";

/**
 * The company behind an onboarding, as Grasp keeps it: its own details, who Grasp deals with
 * there, the contract and the agreements that go with it, who is invited into its platform, and
 * what it connected. Each is the organization's own, with what a person at Grasp changed here on
 * top. Days are ISO dates; `today` is always given, so the same day gives the same answer. Pure.
 */

/** The ISO day `days` after `day`. */
export const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** The ISO day `months` after `day`; a day the month does not have becomes its last. */
export const addMonths = (day: string, months: number): string => {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1, 12));
  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12)
  ).getUTCDate();
  first.setUTCDate(Math.min(date, last));
  return first.toISOString().slice(0, 10);
};

/** The month an ISO day is in: "2026-10". */
export const monthOf = (day: string) => day.slice(0, 7);

/** The company's details as they stand: its own, with what Grasp corrected. */
export const companyOf = (org: Org, state: OrgState): Company => ({
  ...org.company,
  ...state.company,
});

/** Who Grasp deals with there, by what for: the company's own people, and the ones changed here. */
export const contactsOf = (
  org: Org,
  state: OrgState
): Partial<Record<ContactRole, Contact>> => {
  const own: Partial<Record<ContactRole, Contact>> = {};
  for (const contact of org.contacts) {
    own[contact.role] = contact;
  }
  return { ...own, ...state.contacts };
};

/** From this many days before a contract ends, Grasp wants to know what follows it. */
export const ENDING_DAYS = 60;

/** The contract as it stands, with what follows from its dates. */
export interface ContractView extends Contract {
  /** Its term has started and has not ended. */
  running: boolean;
  /** Days until it ends; negative once it has. */
  daysLeft: number;
  /** The last day notice can be given, when it carries on by itself. */
  noticeBy: string | null;
  /** It ends soon, and nothing is agreed for after. */
  ending: boolean;
}

export const contractOf = (
  org: Org,
  state: OrgState,
  today: string
): ContractView => {
  const contract: Contract = { ...org.contract, ...state.contract };
  const signed = contract.status === "signed";
  const daysLeft = daysBetween(today, contract.until);
  return {
    ...contract,
    running: signed && contract.from <= today && today <= contract.until,
    daysLeft,
    noticeBy: contract.renews
      ? addMonths(contract.until, -contract.notice)
      : null,
    ending:
      signed && !contract.renews && daysLeft >= 0 && daysLeft <= ENDING_DAYS,
  };
};

/** VAT on what Grasp bills, as a share of the fee. */
export const VAT = 0.21;

/** An invoice is paid within this many days. */
const PAID_AFTER = 14;

/** One invoice for a month of the contract, VAT included. */
export interface AdminInvoice {
  number: string;
  date: string;
  amount: number;
  status: "paid" | "due";
}

/** The invoices a signed contract has brought so far, the newest first: one a month, from the day it starts. */
export const invoicesOf = (
  org: Org,
  contract: ContractView,
  today: string
): AdminInvoice[] => {
  if (contract.status !== "signed") {
    return [];
  }
  const prefix = org.id.slice(0, 5).toUpperCase();
  const invoices: AdminInvoice[] = [];
  for (let month = 0; ; month += 1) {
    const date = addMonths(contract.from, month);
    if (date > today || date > contract.until) {
      break;
    }
    invoices.push({
      number: `${prefix}-${String(month + 1).padStart(4, "0")}`,
      date,
      amount: Math.round(contract.fee * (1 + VAT) * 100) / 100,
      status: daysBetween(date, today) >= PAID_AFTER ? "paid" : "due",
    });
  }
  return invoices.toReversed();
};

/** The agreements that have to be in place before anyone is invited. */
export const AGREEMENTS = [
  "processing",
  "assessment",
  "council",
] as const satisfies readonly (keyof Agreed)[];

/** Where one agreement stands, and how it was signed. */
export interface AgreementView {
  what: keyof Agreed;
  /** In place; still to sign; with the works council, which is deciding; or not needed, as there is no works council. */
  state: "signed" | "open" | "waiting" | "none";
  /** The day it was put in place, when that is known. */
  on: string | null;
  by: string | null;
  version: string | null;
  file: string | null;
}

export const agreementsOf = (org: Org, state: OrgState): AgreementView[] =>
  AGREEMENTS.map((what): AgreementView => {
    const now = state.agreed[what];
    let stands: AgreementView["state"] = "open";
    if (now === true || now === "yes") {
      stands = "signed";
    } else if (now === "waiting" || now === "none") {
      stands = now;
    }
    const paper = stands === "signed" ? org.papers[what] : undefined;
    // Put in place here by hand: the day it was done, and no paper to show for it yet.
    const byHand = stands === "signed" ? state.papers[what] : undefined;
    const handDone = byHand !== undefined && byHand !== "";
    return {
      what,
      state: stands,
      on: handDone ? byHand : (paper?.signed ?? null),
      by: handDone ? null : (paper?.by ?? null),
      version: handDone ? null : (paper?.version ?? null),
      file: handDone ? null : (paper?.file ?? null),
    };
  });

/** Where someone stands with the platform: their invitation waits, they are ready for when it opens, they are in, or their access was taken away. */
export type MemberState = "invited" | "ready" | "active" | "removed";

export interface MemberView extends Omit<Member, "seen"> {
  state: MemberState;
  /** The last day they were in; none before the platform opens. */
  seen: string | null;
  /** Grasp gave them another role than they had. */
  changed: boolean;
  /** Grasp invited them here, on the company's request. */
  byGrasp: boolean;
  /** The day their invitation was sent again. */
  resent: string | null;
}

/** Everyone invited into the company's platform by `asOf`, in the order they were invited. */
export const membersOf = (
  view: OrgView,
  asOf: string,
  open: boolean
): MemberView[] => {
  const { org, state } = view;
  const mine = new Set(state.invited.map((member) => member.id));
  return [...org.members, ...state.invited]
    .filter((member) => member.invited <= asOf)
    .map((member): MemberView => {
      const role: MemberRole = state.roles[member.id] ?? member.role;
      const joined = member.joined !== undefined && member.joined <= asOf;
      let stands: MemberState = "invited";
      if (state.removed.includes(member.id)) {
        stands = "removed";
      } else if (joined) {
        stands = open ? "active" : "ready";
      }
      return {
        ...member,
        role,
        state: stands,
        seen:
          stands === "active" &&
          member.seen !== undefined &&
          member.seen !== "" &&
          member.seen <= asOf
            ? member.seen
            : null,
        changed: role !== member.role,
        byGrasp: mine.has(member.id),
        resent: state.resent[member.id] ?? null,
      };
    });
};

/** How many of the seats the contract gives are taken: everyone invited whose access was not taken away. */
export const seatsOf = (
  members: MemberView[],
  contract: Contract
): { used: number; of: number } => ({
  used: members.filter((member) => member.state !== "removed").length,
  of: contract.seats,
});

export interface IntegrationView extends Integration {
  /** The day Grasp asked the company's admin to sign in again; none while nobody asked. */
  asked: string | null;
}

/**
 * What the company has connected by `asOf`. The sign-in comes first, in its own onboarding; its HR
 * platform, its documents, Pulse and its apps follow once it has named its team leads.
 */
export const integrationsOf = (
  view: OrgView,
  asOf: string
): IntegrationView[] => {
  const { org, state } = view;
  if (org.made || state.client === "none") {
    return [];
  }
  const further = state.client === "leads" || state.client === "told";
  return org.integrations
    .filter(
      (integration) =>
        (integration.kind === "signIn" || further) && integration.since <= asOf
    )
    .map((integration) => ({
      ...integration,
      asked: state.asked[integration.id] ?? null,
    }));
};
