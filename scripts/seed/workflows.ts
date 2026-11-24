/**
 * The demo company's workflows beside its Apps' (scripts/seed/apps.ts),
 * so the Workflows page shows what a company's workflows look like: what
 * starts each one (an email to its own address, a schedule, a person),
 * one someone paused and one still being built. Each stands on its own,
 * bound to no App, as a workflow made in chat does.
 */
import type { WorkflowTriggerCreate } from "@grasp-os/shared/workflow-triggers";

import type { WorkflowSeed } from "./apps.ts";
import type { PersonKey, TeamName } from "./company.ts";
import { boolean, objectOf, raiseWhen, text } from "./definitions.ts";

/**
 * What starts a workflow's runs, as the seed creates it: an email to an
 * address of its own (its local part), or a schedule.
 */
export type TriggerSeed =
  | {
      kind: "email";
      address: string;
      /** Each input field from the message: `/subject`, `/from/address`, `/text`. */
      fields: Record<string, string>;
    }
  | { kind: "schedule"; cron: string; timeZone: string };

/** The trigger's configuration, as core takes it for `workflowId`. */
export const triggerOf = (
  workflowId: string,
  trigger: TriggerSeed
): WorkflowTriggerCreate =>
  trigger.kind === "email"
    ? {
        kind: "email",
        workflowId,
        config: {
          address: trigger.address,
          input: { fields: trigger.fields, defaults: {} },
        },
      }
    : {
        kind: "schedule",
        workflowId,
        config: {
          schedule: { cron: trigger.cron, timeZone: trigger.timeZone },
          input: {},
          missedOccurrences: "coalesce",
        },
      };

/** What starts the Apps' own workflows, by their names. */
export const appTriggers: Readonly<Record<string, TriggerSeed>> = {
  "client-onboarding": {
    kind: "email",
    address: "aanvragen",
    fields: { client: "/from/address" },
  },
  "email-triage": {
    kind: "email",
    address: "info",
    fields: { from: "/from/address", subject: "/subject", body: "/text" },
  },
  "weekly-report": {
    kind: "schedule",
    cron: "0 7 * * 1",
    timeZone: "Europe/Amsterdam",
  },
};

/** A workflow of the company's own, beside the Apps'. */
export interface OwnWorkflowSeed extends WorkflowSeed {
  owner: PersonKey;
  /** The team that builds it with its owner. */
  team: TeamName;
  trigger?: TriggerSeed;
  /** Someone paused it, after its runs. */
  paused?: boolean;
  /** Being built: a draft, never published, so it has no runs. */
  drafted?: boolean;
}

const suppliers = [
  "Kantoorhuis Utrecht",
  "Schoonmaak De Ster",
  "Drukkerij Vos",
  "IT Beheer Nederland",
  "Koffiebranderij Bunnik",
  "Energie Direct Zakelijk",
] as const;

const totals = ["€184.20", "€1,240.00", "€86.50", "€2,960.00", "€412.75"];

const invoiceIntake: OwnWorkflowSeed = {
  id: "invoice-intake",
  alias: "invoiceIntake",
  title: "Invoice intake",
  owner: "eva",
  team: "Finance",
  trigger: {
    kind: "email",
    address: "facturen",
    fields: { supplier: "/from/address", invoice: "/subject", total: "/text" },
  },
  parts: {
    args: objectOf({ supplier: text, invoice: text, total: text }),
    returns: objectOf({ supplier: text, invoice: text, booked: boolean }),
    result: {
      supplier: { $expr: "args.supplier" },
      invoice: { $expr: "args.invoice" },
      booked: { $expr: 'args.total.trim() !== ""' },
    },
    steps: [
      raiseWhen("noSupplier", 'args.supplier.trim() === ""', {
        code: "invoice.no_supplier",
        message: "The invoice names no supplier, so it can't be booked.",
      }),
    ],
  },
  declared: { args: "v.any()", returns: "v.any()" },
  tests: "",
  sample: { supplier: "Drukkerij Vos", invoice: "2026-0412", total: "€86.50" },
  runs: (draw) =>
    Array.from({ length: 64 }, (_, index) => ({
      by: "eva" as const,
      input: {
        supplier: draw.pick(suppliers),
        invoice: `2026-${String(400 + index).padStart(4, "0")}`,
        total: draw.pick(totals),
      },
    })),
};

const kycCheck: OwnWorkflowSeed = {
  id: "kyc-check",
  alias: "kycCheck",
  title: "KYC check",
  owner: "pieter",
  team: "Compliance",
  paused: true,
  parts: {
    args: objectOf({ client: text, idChecked: boolean, sanctionsHit: boolean }),
    returns: objectOf({ client: text, cleared: boolean }),
    result: {
      client: { $expr: "args.client" },
      cleared: { $expr: "args.idChecked && !args.sanctionsHit" },
    },
    steps: [],
  },
  declared: { args: "v.any()", returns: "v.any()" },
  tests: "",
  sample: { client: "Fam. Willems", idChecked: true, sanctionsHit: false },
  runs: (draw) =>
    Array.from({ length: 9 }, () => ({
      by: "pieter" as const,
      input: {
        client: draw.pick(["Fam. Willems", "D. Mulder", "K. Jacobs", "T. Kok"]),
        idChecked: true,
        sanctionsHit: false,
      },
    })),
};

const monthEndClose: OwnWorkflowSeed = {
  id: "month-end-close",
  alias: "monthEndClose",
  title: "Month-end close",
  owner: "eva",
  team: "Finance",
  drafted: true,
  parts: {
    args: objectOf({ month: text }),
    returns: objectOf({ month: text, closed: boolean }),
    result: { month: { $expr: "args.month" }, closed: false },
    steps: [],
  },
  declared: { args: "v.any()", returns: "v.any()" },
  tests: "",
  sample: { month: "2026-11" },
  runs: () => [],
};

export const ownWorkflows: readonly OwnWorkflowSeed[] = [
  invoiceIntake,
  kycCheck,
  monthEndClose,
];
