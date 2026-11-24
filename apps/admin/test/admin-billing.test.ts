import { env, exports } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { Billing } from "../src/billing/billing.ts";
import { setStripeCustomerFn } from "../src/billing/functions.ts";
import { stripeReadTools } from "../src/billing/stripe.ts";
import type { ClientAdmin } from "../src/clients/admin.ts";
import {
  fetchClientAdmin,
  fetchClientAdmins,
  fetchClientGrid,
} from "../src/clients/functions.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";
import { emptyAdminSnapshot } from "./snapshots.ts";
import { daysFrom, fakeStripeMcp } from "./stripe-mcp.ts";

const token = "test-deployer-token-admin-billing-7d2e41";
/** A restricted key, as Stripe makes them; never a real one. */
const stripeKey = "rk_test_console_billing_fake_key_4f1c";

const cloudflare = mockCloudflareApi(token);
mockAccess();
const stripe = fakeStripeMcp(stripeKey);

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/**
 * Before each test: only its own clients are read (an earlier test's
 * accounts are gone from the fakes, and its customers with them), and with
 * `withKey`, the restricted key is in Secrets Store, as someone at Grasp
 * would put it there (after `useStoreSecrets`, which takes it out after).
 */
const eachTest = ({ withKey }: { withKey: boolean }): void => {
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
    if (withKey) {
      await setStoreSecret(
        env.STRIPE_RESTRICTED_KEY,
        "STRIPE_RESTRICTED_KEY",
        stripeKey
      );
    }
  });
};

/** An active client running a new release, as a deploy made it live, whose core answers an empty snapshot. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): billing");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Noordkade ${clientId}`;
  const { core } = await livePlacedClient(cloudflare, release, {
    id: clientId,
    name,
    signIn: null,
  });
  core.admin = emptyAdminSnapshot("Noordkade");
  return clientId;
};

/** Links `clientId` to Stripe customer `customerId` (null unlinks), as staff do on its Billing. */
const link = async (clientId: string, customerId: string | null) =>
  await callServerFn(
    setStripeCustomerFn,
    { clientId, customerId },
    { email: staff.email }
  );

/** Client `clientId` as its organization's page reads it, as the staff member. */
const adminOf = async (clientId: string): Promise<ClientAdmin | null> =>
  await callServerFn(fetchClientAdmin, { clientId }, { email: staff.email });

/** Client `clientId`'s billing, as its page reads it. */
const billingOf = async (clientId: string): Promise<Billing | undefined> => {
  const admin = await adminOf(clientId);
  return admin?.state === "answered" ? admin.billing : undefined;
};

const now = new Date();
/** The day a Unix time falls on. */
const dayOf = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

/** `amount` euros. */
const euros = (amount: number) => ({ amount, currency: "eur" });

/** A customer Stripe charges each month, with its last two invoices paid. */
const paying = (customerId: string) => {
  const renews = daysFrom(now, 20);
  const paidAt = daysFrom(now, -9);
  return {
    renews,
    paidAt,
    held: {
      customer: {
        id: customerId,
        object: "customer",
        name: "Noordkade B.V.",
        email: "finance@noordkade.test",
        currency: "eur",
      },
      subscriptions: [
        {
          id: "sub_noordkade",
          object: "subscription",
          customer: customerId,
          status: "active",
          collection_method: "charge_automatically",
          days_until_due: null,
          cancel_at_period_end: false,
          cancel_at: null,
          items: {
            object: "list",
            data: [
              {
                id: "si_noordkade",
                quantity: 1,
                current_period_end: renews,
                price: {
                  id: "price_plan",
                  unit_amount: 150_000,
                  currency: "eur",
                },
              },
            ],
          },
        },
      ],
      invoices: [
        {
          id: "in_2",
          object: "invoice",
          customer: customerId,
          number: "NK-0002",
          status: "paid",
          created: daysFrom(now, -10),
          due_date: null,
          total: 181_500,
          amount_remaining: 0,
          currency: "eur",
          attempted: true,
          collection_method: "charge_automatically",
          status_transitions: { paid_at: paidAt },
        },
        {
          id: "in_1",
          object: "invoice",
          customer: customerId,
          number: "NK-0001",
          status: "paid",
          created: daysFrom(now, -40),
          due_date: null,
          total: 181_500,
          amount_remaining: 0,
          currency: "eur",
          attempted: true,
          collection_method: "charge_automatically",
          status_transitions: { paid_at: daysFrom(now, -39) },
        },
      ],
    },
  };
};

/** A customer sent its invoices to pay within 14 days, one of them unpaid 10 days past its due date. */
const late = (customerId: string) => {
  const due = daysFrom(now, -10);
  const { held } = paying(customerId);
  return {
    due,
    held: {
      ...held,
      subscriptions: held.subscriptions.map((subscription) => ({
        ...subscription,
        collection_method: "send_invoice",
        days_until_due: 14,
      })),
      invoices: [
        {
          id: "in_3",
          object: "invoice",
          customer: customerId,
          number: "NK-0003",
          status: "open",
          created: daysFrom(now, -24),
          due_date: due,
          total: 181_500,
          amount_remaining: 181_500,
          currency: "eur",
          attempted: false,
          collection_method: "send_invoice",
          status_transitions: { paid_at: null },
        },
        ...held.invoices,
      ],
    },
  };
};

describe("an organization's billing, with Stripe's key", () => {
  useStoreSecrets({ deployer: token });
  eachTest({ withKey: true });

  it("reads a linked company's customer, how it pays, what it paid last and its next invoice, all paid", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadePaid1";
    const { held, renews, paidAt } = paying(customerId);
    stripe.customers.set(customerId, held);

    const linked = await link(clientId, customerId);
    const admin = await adminOf(clientId);

    expect({
      linked,
      billing: admin?.state === "answered" ? admin.billing : undefined,
      // Nothing of the customer's email is read, or needed.
      email: JSON.stringify(admin).includes("finance@noordkade.test"),
      keyed: stripe.unkeyed,
    }).toStrictEqual({
      linked: { changed: true, refused: null },
      billing: {
        state: "read",
        customerId,
        account: {
          name: "Noordkade B.V.",
          url: `https://dashboard.stripe.com/test/customers/${customerId}`,
          pays: { by: "charge" },
          subscription: {
            status: "active",
            next: { on: dayOf(renews), amount: euros(1500) },
            ends: null,
          },
          open: { count: 0, amount: [] },
          overdue: { count: 0, amount: [], since: null },
          lastPaid: { on: dayOf(paidAt), amount: euros(1815) },
          invoices: [
            {
              number: "NK-0002",
              date: dayOf(daysFrom(now, -10)),
              amount: 1815,
              currency: "eur",
              status: "paid",
              due: null,
            },
            {
              number: "NK-0001",
              date: dayOf(daysFrom(now, -40)),
              amount: 1815,
              currency: "eur",
              status: "paid",
              due: null,
            },
          ],
        },
      },
      email: false,
      keyed: 0,
    });
  });

  it("reads an invoice past its due date as overdue, with the day it was due", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadeLate1";
    const { held, due } = late(customerId);
    stripe.customers.set(customerId, held);

    await link(clientId, customerId);
    const billing = await billingOf(clientId);

    expect(
      billing?.state === "read"
        ? {
            pays: billing.account.pays,
            open: billing.account.open,
            overdue: billing.account.overdue,
            invoice: billing.account.invoices.find(
              ({ number }) => number === "NK-0003"
            ),
          }
        : billing
    ).toStrictEqual({
      pays: { by: "invoice", daysToPay: 14 },
      open: { count: 1, amount: [euros(1815)] },
      overdue: { count: 1, amount: [euros(1815)], since: dayOf(due) },
      invoice: {
        number: "NK-0003",
        date: dayOf(daysFrom(now, -24)),
        amount: 1815,
        currency: "eur",
        status: "overdue",
        due: dayOf(due),
      },
    });
  });

  it("never shows another customer's invoices, whatever Stripe's server answers", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadeOwn1";
    const { held } = paying(customerId);
    const other = late("cus_SomeoneElse1").held;
    // A server that ignores the filter: the other customer's invoice comes along.
    stripe.customers.set(customerId, {
      ...held,
      invoices: [...other.invoices.slice(0, 1), ...held.invoices],
    });

    await link(clientId, customerId);
    const billing = await billingOf(clientId);

    expect(
      billing?.state === "read"
        ? {
            invoices: billing.account.invoices.map(({ number }) => number),
            open: billing.account.open.count,
          }
        : billing
    ).toStrictEqual({ invoices: ["NK-0002", "NK-0001"], open: 0 });
  });

  it("calls only the read tools on its list, though Stripe's server lists write tools too", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadeTools1";
    stripe.customers.set(customerId, late(customerId).held);

    await link(clientId, customerId);
    await adminOf(clientId);

    const called = stripe.called.map(({ tool }) => tool);
    const allowed: readonly string[] = stripeReadTools;
    expect({
      some: called.length > 0,
      outside: called.filter((tool) => !allowed.includes(tool)),
      each: [...new Set(called)].toSorted(),
      // Every read names this customer, and only it.
      customers: [
        ...new Set(
          stripe.called.map(({ input }) => input.customer ?? input.id)
        ),
      ],
    }).toStrictEqual({
      some: true,
      outside: [],
      each: [...stripeReadTools].toSorted(),
      customers: [customerId],
    });
  });

  it("never sends Stripe's key, or what Stripe holds beyond what the page shows, to the browser", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadeBrowser1";
    stripe.customers.set(customerId, paying(customerId).held);
    await link(clientId, customerId);

    // Everything the organization's page gets: its document, and the
    // answers of each server function it reads with.
    const document = await exports.default.fetch(
      `https://ops.grasp.test/organizations/${clientId}/details?tab=contract`,
      { headers: { "cf-access-jwt-assertion": await accessJwt(staff.email) } }
    );
    const sent = JSON.stringify([
      await document.text(),
      await callServerFn(fetchClientGrid, undefined, { email: staff.email }),
      await callServerFn(fetchClientAdmins, undefined, { email: staff.email }),
      await adminOf(clientId),
    ]);

    expect({
      status: document.status,
      key: sent.includes(stripeKey),
      email: sent.includes("finance@noordkade.test"),
      shown: sent.includes("Noordkade B.V."),
    }).toStrictEqual({ status: 200, key: false, email: false, shown: true });
  });

  it("reads a company not linked yet as such, and asks Stripe nothing for it", async () => {
    const clientId = await liveClient();

    const billing = await billingOf(clientId);

    expect({ billing, requests: stripe.requests }).toStrictEqual({
      billing: { state: "not_linked" },
      requests: 0,
    });
  });

  it("links only by a customer's id, audits each change, and unlinks", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadeLink1";

    const byName = await link(clientId, "Noordkade B.V.");
    const linked = await link(clientId, customerId);
    const again = await link(clientId, customerId);
    const unlinked = await link(clientId, null);
    const unknown = await link("no-such-client", customerId);
    const events = await db
      .select({
        actor: auditEvents.actor,
        target: auditEvents.target,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "client.stripe_customer")
        )
      )
      .orderBy(auditEvents.at);
    const [row] = await db
      .select({ customerId: clients.stripeCustomerId })
      .from(clients)
      .where(eq(clients.id, clientId));

    expect({
      byName,
      linked,
      again,
      unlinked,
      unknown,
      events,
      kept: row?.customerId,
    }).toStrictEqual({
      byName: { changed: null, refused: "customer_id_invalid" },
      linked: { changed: true, refused: null },
      again: { changed: false, refused: null },
      unlinked: { changed: true, refused: null },
      unknown: { changed: null, refused: "unknown_client" },
      events: [
        { actor: staff.email, target: customerId },
        { actor: staff.email, target: null },
      ],
      kept: null,
    });
  });
});

describe("an organization's billing, without Stripe's key", () => {
  useStoreSecrets({ deployer: token });
  eachTest({ withKey: false });

  it("reads Stripe as not connected, keeps the customer it is linked to, and asks Stripe nothing", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadeNoKey1";
    stripe.customers.set(customerId, late(customerId).held);

    await link(clientId, customerId);
    const billing = await billingOf(clientId);

    expect({ billing, requests: stripe.requests }).toStrictEqual({
      billing: { state: "not_connected", customerId },
      requests: 0,
    });
  });
});
