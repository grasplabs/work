import { env, exports } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { formatDate } from "../src/admin/words.ts";
import { setStripeCustomerFn } from "../src/billing/functions.ts";
import { stripeReadTools } from "../src/billing/stripe.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { emptyAdminSnapshot, mockCloudflareApi } from "./cloudflare-api.ts";
import { callServerFn, page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";
import { daysFrom, fakeStripeMcp } from "./stripe-mcp.ts";

const token = "test-deployer-token-admin-billing-7d2e41";
const tenantToken = "test-tenant-admin-token-admin-billing-93ac06";
/** A restricted key, as Stripe makes them; never a real one. */
const stripeKey = "rk_test_console_billing_fake_key_4f1c";

const cloudflare = mockCloudflareApi(token, tenantToken);
mockAccess();
const stripe = fakeStripeMcp(stripeKey);

const db = consoleDatabase(env.DB);
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
  const release = await publishRelease({ notes: "feat(core): billing" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Noordkade ${clientId}`;
  const account = cloudflare.addAccount(name);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name,
        accountId: account.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, release.id)
  );
  account.admin = emptyAdminSnapshot("Noordkade");
  return clientId;
};

/** Links `clientId` to Stripe customer `customerId` (null unlinks), as staff do on its Billing. */
const link = async (clientId: string, customerId: string | null) =>
  await callServerFn(
    setStripeCustomerFn,
    { clientId, customerId },
    { email: staff.email }
  );

/** The page's main part, past the column of sections. */
const mainOf = (html: string): string => html.slice(html.indexOf("<main"));

/** The text of the line under `label`, tags taken out. */
const lineOf = (html: string, label: string): string => {
  const at = html.indexOf(`>${label}</dt>`);
  if (at === -1) {
    return "";
  }
  const start = html.indexOf("<dd", at);
  const end = html.indexOf("</dd>", start);
  return html
    .slice(html.indexOf(">", start) + 1, end)
    .replaceAll(/<[^>]*>/gu, "");
};

const contractOf = async (clientId: string): Promise<string> => {
  const { html } = await page(`/admin/organizations/${clientId}/contract`);
  return mainOf(html);
};

const overviewOf = async (clientId: string): Promise<string> => {
  const { html } = await page(`/admin/organizations/${clientId}`);
  return mainOf(html);
};

const now = new Date();
/** The day a Unix time falls on, as the page says it. */
const dayOf = (seconds: number): string =>
  formatDate(new Date(seconds * 1000).toISOString().slice(0, 10));

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
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  eachTest({ withKey: true });

  it("shows a linked company's customer, how it pays, what it paid last and its next invoice, all paid, and nothing that needs Grasp", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadePaid1";
    const { held, renews, paidAt } = paying(customerId);
    stripe.customers.set(customerId, held);

    const linked = await link(clientId, customerId);
    const contract = await contractOf(clientId);
    const overview = await overviewOf(clientId);

    expect({
      linked,
      line: contract.includes("Everything billed is paid."),
      customer: lineOf(contract, "Customer in Stripe"),
      opens: contract.includes(
        `https://dashboard.stripe.com/test/customers/${customerId}`
      ),
      pays: lineOf(contract, "How it pays"),
      open: lineOf(contract, "Open"),
      overdue: lineOf(contract, "Overdue"),
      lastPaid: lineOf(contract, "Last paid"),
      next: lineOf(contract, "Next invoice"),
      invoices: ["NK-0002", "NK-0001"].map((number) =>
        contract.includes(`>${number}</span>`)
      ),
      inStripe: contract.includes("From Stripe, the latest 2. All are paid."),
      notConnected: contract.includes("Once Stripe is connected"),
      // Nothing of the customer's email is shown, or needed.
      email: contract.includes("finance@noordkade.test"),
      needs: overview.includes("overdue"),
      keyed: stripe.unkeyed,
    }).toStrictEqual({
      linked: { changed: true, refused: null },
      line: true,
      customer: "Noordkade B.V.",
      opens: true,
      pays: "Stripe charges it each time",
      open: "Nothing",
      overdue: "Nothing",
      lastPaid: `€1,815.00 on ${dayOf(paidAt)}`,
      next: `€1,500.00 on ${dayOf(renews)}, before tax`,
      invoices: [true, true],
      inStripe: true,
      notConnected: false,
      email: false,
      needs: false,
      keyed: 0,
    });
  });

  it("shows an overdue invoice in Billing and among what needs Grasp", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadeLate1";
    const { held, due } = late(customerId);
    stripe.customers.set(customerId, held);

    await link(clientId, customerId);
    const contract = await contractOf(clientId);
    const overview = await overviewOf(clientId);

    expect({
      line: contract.includes("1 invoice is overdue, €1,815.00 in all."),
      pays: lineOf(contract, "How it pays"),
      open: lineOf(contract, "Open"),
      overdue: lineOf(contract, "Overdue"),
      invoice: /NK-0003<\/span>.*?>Overdue</su.test(contract),
      need: overview.includes(
        `An invoice of €1,815.00 is overdue: it was due on ${dayOf(due)}.`
      ),
      health: overview.includes("An invoice is overdue"),
    }).toStrictEqual({
      line: true,
      pays: "It is sent each invoice, to pay within 14 days",
      open: "€1,815.00, 1 invoice",
      overdue: `€1,815.00, due since ${dayOf(due)}`,
      invoice: true,
      need: true,
      health: true,
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
    const contract = await contractOf(clientId);

    expect({
      theirs: contract.includes("NK-0003"),
      line: contract.includes("Everything billed is paid."),
    }).toStrictEqual({ theirs: false, line: true });
  });

  it("calls only the read tools on its list, though Stripe's server lists write tools too", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadeTools1";
    stripe.customers.set(customerId, late(customerId).held);

    await link(clientId, customerId);
    await contractOf(clientId);
    await overviewOf(clientId);

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

    // The whole page, scripts and the data they hydrate with included.
    const response = await exports.default.fetch(
      `https://console.grasp.test/admin/organizations/${clientId}/contract`,
      { headers: { "cf-access-jwt-assertion": await accessJwt(staff.email) } }
    );
    const html = await response.text();

    expect({
      status: response.status,
      key: html.includes(stripeKey),
      email: html.includes("finance@noordkade.test"),
      shown: html.includes("Noordkade B.V."),
    }).toStrictEqual({ status: 200, key: false, email: false, shown: true });
  });

  it("says a company not linked yet isn't, and asks Stripe nothing for it", async () => {
    const clientId = await liveClient();

    const contract = await contractOf(clientId);

    expect({
      line: contract.includes(
        "Not linked to its customer in Stripe yet. Link it by the customer’s id, and this fills in by itself."
      ),
      form: contract.includes('name="customerId"'),
      // The invoices are the model's own, as before Stripe was read.
      invoices: contract.includes("None known yet"),
      requests: stripe.requests,
    }).toStrictEqual({ line: true, form: true, invoices: true, requests: 0 });
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
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  eachTest({ withKey: false });

  it("says Stripe isn't connected, keeps the customer it is linked to, and asks Stripe nothing", async () => {
    const clientId = await liveClient();
    const customerId = "cus_NoordkadeNoKey1";
    stripe.customers.set(customerId, late(customerId).held);

    await link(clientId, customerId);
    const contract = await contractOf(clientId);
    const overview = await overviewOf(clientId);

    expect({
      line: contract.includes(
        "Once Stripe is connected, this fills in by itself."
      ),
      linkedTo: contract.includes(`value="${customerId}"`),
      overdue: overview.includes("overdue"),
      requests: stripe.requests,
    }).toStrictEqual({
      line: true,
      linkedTo: true,
      overdue: false,
      requests: 0,
    });
  });
});
