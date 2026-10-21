import { deadline } from "@grasp-os/shared/deadline";
/**
 * What each company pays Grasp and whether it is paid, for the admin's
 * Billing under Contract: its customer in Grasp's Stripe, linked by hand
 * (`clients.stripeCustomerId`, src/billing/link.ts), read through Stripe's
 * MCP server each time the admin reads its organizations
 * (src/billing/stripe.ts). The console keeps only the link; nothing Stripe
 * answers is stored.
 *
 * What reaches the browser is `Billing`: what the page shows, worked out
 * here, never Stripe's objects as it sent them, and never the key.
 */
import { log } from "@grasp-os/shared/log";
import { isNotNull } from "drizzle-orm";

import { ifStored } from "../clients/grid.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { storeSecret } from "../deploy/context.ts";
import { readStripeCustomer } from "./stripe.ts";
import type {
  StripeInvoice,
  StripeReadError,
  StripeRecords,
  StripeSubscription,
} from "./stripe.ts";

/** One invoice, as the Invoices under Contract list it. */
export interface BillingInvoice {
  /** Its number; a draft's id, as it has none yet. */
  number: string;
  /** The day it was made. */
  date: string;
  /** What it comes to, VAT included, in `currency`'s units, not cents. */
  amount: number;
  /** Stripe's code for it, lower case: `eur`. */
  currency: string;
  /**
   * Paid; open and not due yet; overdue (past its due date, or a payment
   * Stripe took for it failed); void; or written off as uncollectible.
   */
  status: "paid" | "open" | "overdue" | "void" | "uncollectible" | "draft";
  /** The day it is due; null for one Stripe charges itself. */
  due: string | null;
}

/** An amount in a currency. */
export interface Money {
  amount: number;
  currency: string;
}

/** What Stripe says of the company, worked out for the page. */
export interface BillingAccount {
  /** The customer's name in Stripe. */
  name: string | null;
  /** The customer in Stripe's dashboard. */
  url: string;
  /**
   * How it pays: Stripe charges it, or it is sent each invoice to pay
   * within `daysToPay`; null when nothing says yet.
   */
  pays: { by: "charge" } | { by: "invoice"; daysToPay: number | null } | null;
  /** Its subscription, if one runs. */
  subscription: {
    status: string;
    /** The next invoice, before tax: null when it ends instead. */
    next: { on: string; amount: Money | null } | null;
    /** The day it ends, when it is cancelled for then. */
    ends: string | null;
  } | null;
  /** Invoices not paid yet, overdue ones too: how many, and what is left to pay. */
  open: { count: number; amount: Money[] };
  /** Invoices past their due date, and the day the oldest was due. */
  overdue: { count: number; amount: Money[]; since: string | null };
  /** The invoice paid last. */
  lastPaid: { on: string; amount: Money } | null;
  /** Its latest invoices, the newest first. */
  invoices: BillingInvoice[];
}

/**
 * The company's billing, as far as it is read:
 * - `not_connected`: Secrets Store has no key, so Stripe isn't read at
 *   all; the customer it is linked to, if any, is still said;
 * - `not_linked`: nobody at Grasp linked it to a customer yet;
 * - `unread`: Stripe wasn't read now, and why;
 * - `read`: what Stripe says.
 */
export type Billing =
  | { state: "not_connected"; customerId: string | null }
  | { state: "not_linked" }
  | {
      state: "unread";
      customerId: string;
      url: string;
      error: StripeReadError;
    }
  | { state: "read"; customerId: string; account: BillingAccount };

/** The day a Unix time falls on, in UTC. */
const dayOf = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

/** How many minor units a currency has: 2 for euros, 0 for yen. */
const decimalsOf = (currency: string): number => {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: currency.toUpperCase(),
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
};

/** Stripe's amount in minor units as one in `currency`'s units. */
const unitsOf = (minor: number, currency: string): number =>
  minor / 10 ** decimalsOf(currency);

/** Amounts added up, one sum for each currency, in the order they first come. */
const sums = (amounts: readonly Money[]): Money[] => {
  const totals = new Map<string, number>();
  for (const { amount, currency } of amounts) {
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
  }
  return [...totals].map(([currency, amount]) => ({
    currency,
    amount: Math.round(amount * 100) / 100,
  }));
};

/**
 * Whether an open invoice is overdue at `now`: past the day it was due,
 * or, for one Stripe charges itself (with no due date), once a payment
 * it took failed.
 */
const isOverdue = (invoice: StripeInvoice, now: Date): boolean => {
  if (invoice.status !== "open") {
    return false;
  }
  if (invoice.due_date !== null && invoice.due_date !== undefined) {
    return dayOf(invoice.due_date) < now.toISOString().slice(0, 10);
  }
  return invoice.attempted === true;
};

const invoiceOf = (invoice: StripeInvoice, now: Date): BillingInvoice => {
  let status: BillingInvoice["status"] = invoice.status ?? "draft";
  if (isOverdue(invoice, now)) {
    status = "overdue";
  }
  return {
    number: invoice.number ?? invoice.id,
    date: dayOf(invoice.created),
    amount: unitsOf(invoice.total, invoice.currency),
    currency: invoice.currency,
    status,
    due:
      invoice.due_date === null || invoice.due_date === undefined
        ? null
        : dayOf(invoice.due_date),
  };
};

/** When a subscription's period ends: on it, or, in later API versions, on its items. */
const periodEnd = (subscription: StripeSubscription): number | null => {
  if (subscription.current_period_end !== undefined) {
    return subscription.current_period_end;
  }
  const ends = (subscription.items?.data ?? []).flatMap((item) =>
    item.current_period_end === undefined ? [] : [item.current_period_end]
  );
  return ends.length === 0 ? null : Math.min(...ends);
};

/** What a subscription's items come to each period, before tax and discounts; null when an item's price isn't fixed. */
const periodAmount = (subscription: StripeSubscription): Money | null => {
  const items = subscription.items?.data ?? [];
  let total = 0;
  let currency = subscription.currency ?? "";
  for (const item of items) {
    const unit = item.price?.unit_amount;
    if (unit === null || unit === undefined || item.price === null) {
      return null;
    }
    currency = item.price?.currency ?? currency;
    total += unit * (item.quantity ?? 1);
  }
  return items.length === 0 || currency === ""
    ? null
    : { amount: unitsOf(total, currency), currency };
};

/** Statuses of a subscription that still bills. */
const billing = new Set(["active", "trialing", "past_due", "unpaid"]);

const subscriptionOf = (
  subscription: StripeSubscription
): BillingAccount["subscription"] => {
  const end = periodEnd(subscription);
  let ends: string | null = null;
  if (subscription.cancel_at !== null && subscription.cancel_at !== undefined) {
    ends = dayOf(subscription.cancel_at);
  } else if (subscription.cancel_at_period_end === true && end !== null) {
    ends = dayOf(end);
  }
  const next =
    billing.has(subscription.status) && ends === null && end !== null
      ? { on: dayOf(end), amount: periodAmount(subscription) }
      : null;
  return { status: subscription.status, next, ends };
};

/** How the company pays: as its subscription says, or else its latest invoice. */
const paysOf = (
  subscription: StripeSubscription | undefined,
  latest: StripeInvoice | undefined
): BillingAccount["pays"] => {
  const method =
    subscription?.collection_method ?? latest?.collection_method ?? null;
  if (method === null) {
    return null;
  }
  return method === "charge_automatically"
    ? { by: "charge" }
    : { by: "invoice", daysToPay: subscription?.days_until_due ?? null };
};

/** The customer in Stripe's dashboard: in test mode for a test key. */
export const dashboardUrl = (customerId: string, key: string): string =>
  `https://dashboard.stripe.com/${/^[rs]k_test_/u.test(key) ? "test/" : ""}customers/${encodeURIComponent(customerId)}`;

/** What Stripe's records on a customer say, at `now`, for the page. */
export const accountOf = (
  { customer, subscriptions, invoices }: StripeRecords,
  url: string,
  now: Date
): BillingAccount => {
  const [subscription] = subscriptions;
  const shown = invoices.map((invoice) => invoiceOf(invoice, now));
  const unpaid = invoices.filter((invoice) => invoice.status === "open");
  const overdue = unpaid.filter((invoice) => isOverdue(invoice, now));
  const left = (each: StripeInvoice): Money => ({
    amount: unitsOf(each.amount_remaining, each.currency),
    currency: each.currency,
  });
  const dues = overdue.map(
    (invoice) => invoiceOf(invoice, now).due ?? dayOf(invoice.created)
  );
  const paid = invoices.find((invoice) => invoice.status === "paid");
  const paidAt = paid?.status_transitions?.paid_at ?? paid?.created;
  return {
    name: customer.name ?? null,
    url,
    pays: paysOf(subscription, invoices[0]),
    subscription:
      subscription === undefined ? null : subscriptionOf(subscription),
    open: { count: unpaid.length, amount: sums(unpaid.map(left)) },
    overdue: {
      count: overdue.length,
      amount: sums(overdue.map(left)),
      since: dues.length === 0 ? null : (dues.toSorted()[0] ?? null),
    },
    lastPaid:
      paid === undefined || paidAt === undefined
        ? null
        : {
            on: dayOf(paidAt),
            amount: {
              amount: unitsOf(paid.total, paid.currency),
              currency: paid.currency,
            },
          },
    // A draft isn't sent yet: it isn't the company's to pay.
    invoices: shown.filter((invoice) => invoice.status !== "draft"),
  };
};

/** The restricted key, or null while Secrets Store doesn't have it. */
export const stripeKey = async (env: Env): Promise<string | null> =>
  await ifStored(async () => await storeSecret(env, "STRIPE_RESTRICTED_KEY"));

/** The Stripe customer each linked client is linked to, by the client's id. */
export const stripeLinks = async (
  db: ConsoleDatabase
): Promise<Map<string, string>> => {
  const rows = await db
    .select({ id: clients.id, customerId: clients.stripeCustomerId })
    .from(clients)
    .where(isNotNull(clients.stripeCustomerId));
  return new Map(
    rows.flatMap(({ id, customerId }) =>
      customerId === null ? [] : [[id, customerId] as const]
    )
  );
};

/** What reading one client's billing takes. */
export interface BillingRead {
  key: string | null;
  customerId: string | null;
  clientId: string;
  timeoutMs: number;
}

/**
 * Client `clientId`'s billing: not read without a key or a linked
 * customer, else read from Stripe within `timeoutMs`. Never throws.
 */
export const billingOf = async ({
  key,
  customerId,
  clientId,
  timeoutMs,
}: BillingRead): Promise<Billing> => {
  if (key === null) {
    return { state: "not_connected", customerId };
  }
  if (customerId === null) {
    return { state: "not_linked" };
  }
  const url = dashboardUrl(customerId, key);
  const limit = deadline(timeoutMs);
  let error: StripeReadError = "no_answer";
  try {
    const read = await readStripeCustomer({
      key,
      customerId,
      signal: limit.signal,
    });
    if ("records" in read) {
      return {
        state: "read",
        customerId,
        account: accountOf(read.records, url, new Date()),
      };
    }
    ({ error } = read);
  } catch {
    error = limit.stopped() === "timeout" ? "timeout" : "no_answer";
  } finally {
    limit.clear();
  }
  log.warn("admin.billing_unread", { clientId, error });
  return { state: "unread", customerId, url, error };
};
