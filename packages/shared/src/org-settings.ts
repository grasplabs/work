import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// The organization's settings an admin keeps in Grasp (core's
// org-settings.ts), beside its name and time zone (organization.ts): how
// it is billed; and, read only, how its people sign in, which Grasp sets
// up for the deployment. Only the organization's admins read them, and
// only its own admins (never Grasp staff) change them; every change is
// audited, naming what changed, never the values.

/** One line of text, as an invoice prints it. */
const lineSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);

/**
 * An EU VAT number as invoices print it: its country's two letters, then
 * up to twelve letters and digits, without spaces.
 */
export const vatNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}[0-9A-Z]{2,12}$/u);

/**
 * What appears on every invoice, and which billing emails go out. Grasp
 * keeps them; no payment provider is linked yet, so there is no plan,
 * card or invoice to show beside them.
 */
export const billingSettingsSchema = z.strictObject({
  /** Where invoices and receipts go; null until set. */
  email: z.email().max(254).nullable(),
  company: lineSchema(120).nullable(),
  /** The postal address, one line per line of it. */
  address: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^[^\p{Cc}]*(?:\n[^\p{Cc}]*)*$/u)
    .nullable(),
  vatNumber: vatNumberSchema.nullable(),
  /** Each invoice as a PDF to the billing email, as it is issued. */
  emailInvoices: z.boolean(),
  /** A receipt to the billing email each time a payment goes through. */
  emailReceipts: z.boolean(),
});
export type BillingSettings = z.output<typeof billingSettingsSchema>;
export type BillingSettingsInput = z.input<typeof billingSettingsSchema>;

/** Billing until an admin sets it: nothing on file, no emails. */
export const noBilling: BillingSettings = {
  email: null,
  company: null,
  address: null,
  vatNumber: null,
  emailInvoices: false,
  emailReceipts: false,
};

/** One identity provider people sign in with, as the deployment sets it up. */
export interface SignInProvider {
  provider: "microsoft" | "google";
  /** The Entra tenant, pinned: its ID tokens alone are taken. */
  tenantId?: string;
  /** The Google Workspace, pinned by its primary domain. */
  hostedDomain?: string;
  clientId: string;
  /** Whether its client secret is set: never the secret. */
  secretSet: boolean;
  /** Offered on the sign-in page: set up, with its secret. */
  offered: boolean;
}

/**
 * How the organization's people sign in, read only: Grasp sets it up for
 * the deployment (its `SIGN_IN` config and client secrets), so changing it
 * isn't a setting here. No secret is ever in it.
 */
export interface SignInSettings {
  /** Whether sign-in is set up at all; none is offered until it is. */
  configured: boolean;
  /** The email domains people may sign in with. */
  domains: string[];
  providers: SignInProvider[];
  /** Grasp staff's access window: open, and until when (ISO 8601); null without one. */
  staffWindow: { open: boolean; until: string } | null;
}

/** Why a change to the organization's settings was refused. */
export const orgSettingsErrors = defineErrorFamily({
  "org_settings.billing_invalid":
    "Those aren't billing details: a valid email, one-line company, an address of up to 500 characters and an EU VAT number.",
});

/** The organization's settings, over `/rpc`, for its admins. */
export interface OrgSettingsApi {
  /** Billing as Grasp keeps it. Admins, Grasp staff included. */
  billing: () => Promise<BillingSettings>;
  /**
   * Replaces the billing details and emails. The organization's own
   * admins only, never Grasp staff; audited when something changed.
   */
  updateBilling: (billing: BillingSettingsInput) => Promise<BillingSettings>;
  /**
   * How people sign in, as the deployment sets it up, never a secret.
   * Admins, Grasp staff included; not a setting anyone changes here.
   */
  signIn: () => Promise<SignInSettings>;
}
