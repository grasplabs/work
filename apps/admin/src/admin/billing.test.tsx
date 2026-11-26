// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import {
  act,
  answeredAdmin,
  answeredSummary,
  gridRow,
  lineOf,
  openAdmin,
  settle,
} from "../../test/app.tsx";
import type { BillingAccount } from "../billing/billing.ts";
import type { ClientAdmin } from "../clients/admin.ts";
import { formatDate } from "./words.ts";

// An organization's Billing, under Details' Contract tab, and what of it
// needs Grasp on its overview, as Stripe's answer reads
// (test/admin-billing.test.ts: what the Worker reads of Stripe, and that
// nothing of the key or the customer beyond it reaches the browser).

/** The day `days` from now. */
const day = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const euros = (amount: number) => ({ amount, currency: "eur" });

const customerId = "cus_Noordkade1";

/** A customer Stripe charges each month, with its last two invoices paid. */
const paid: BillingAccount = {
  name: "Noordkade B.V.",
  url: `https://dashboard.stripe.com/test/customers/${customerId}`,
  pays: { by: "charge" },
  subscription: {
    status: "active",
    next: { on: day(20), amount: euros(1500) },
    ends: null,
  },
  open: { count: 0, amount: [] },
  overdue: { count: 0, amount: [], since: null },
  lastPaid: { on: day(-9), amount: euros(1815) },
  invoices: ["NK-0002", "NK-0001"].map((number, back) => ({
    number,
    date: day(-10 - back * 30),
    amount: 1815,
    currency: "eur",
    status: "paid",
    due: null,
  })),
};

/** One sent to pay within 14 days, one invoice unpaid 10 days past its due date. */
const late: BillingAccount = {
  ...paid,
  pays: { by: "invoice", daysToPay: 14 },
  open: { count: 1, amount: [euros(1815)] },
  overdue: { count: 1, amount: [euros(1815)], since: day(-10) },
  invoices: [
    {
      number: "NK-0003",
      date: day(-24),
      amount: 1815,
      currency: "eur",
      status: "overdue",
      due: day(-10),
    },
    ...paid.invoices,
  ],
};

/** Acme's Contract tab and its overview, with `billing`. */
const opened = async (
  billing: Extract<ClientAdmin, { state: "answered" }>["billing"]
) => {
  const answers = {
    fetchClientGrid: [gridRow()],
    fetchClientAdmin: answeredAdmin({ billing }),
  };
  const contract = await openAdmin(
    "/organizations/acme/details?tab=contract",
    answers
  );
  const contractText = contract.main();
  const billingPart = contract.container.querySelector("#contract-billing");
  const invoices = contract.container.querySelector("#contract-invoices");
  const lines = Object.fromEntries(
    [
      "Customer in Stripe",
      "How it pays",
      "Open",
      "Overdue",
      "Last paid",
      "Next invoice",
    ].map((label) => [
      label,
      billingPart === null ? undefined : lineOf(billingPart, label),
    ])
  );
  const opens = [...contract.container.querySelectorAll("a")].some(
    (link) => link.getAttribute("href") === paid.url
  );
  const field = contract.container.querySelector<HTMLInputElement>(
    'input[name="customerId"]'
  );
  const overview = await openAdmin("/organizations/acme", answers);
  return {
    contract: contractText,
    lines,
    opens,
    invoices: invoices?.textContent ?? null,
    field: field === null ? null : field.value,
    overview: overview.main(),
  };
};

describe("an organization's billing, as Stripe's answer reads", () => {
  it("shows a linked company's customer, how it pays, what it paid last and its next invoice, all paid, and nothing that needs Grasp", async () => {
    const { contract, lines, opens, invoices, overview } = await opened({
      state: "read",
      customerId,
      account: paid,
    });

    expect({
      line: contract.includes("Everything billed is paid."),
      lines,
      opens,
      invoices: ["NK-0002", "NK-0001"].map((number) =>
        invoices?.includes(number)
      ),
      inStripe: invoices?.includes("From Stripe, the latest 2. All are paid."),
      notConnected: contract.includes("Once Stripe is connected"),
      needs: overview.includes("overdue"),
    }).toStrictEqual({
      line: true,
      lines: {
        "Customer in Stripe": "Noordkade B.V.",
        "How it pays": "Stripe charges it each time",
        Open: "Nothing",
        Overdue: "Nothing",
        "Last paid": `€1,815.00 on ${formatDate(day(-9))}`,
        "Next invoice": `€1,500.00 on ${formatDate(day(20))}, before tax`,
      },
      opens: true,
      invoices: [true, true],
      inStripe: true,
      notConnected: false,
      needs: false,
    });
  });

  it("lists an overdue invoice in the sidebar's Inbox, leading to the Contract tab", async () => {
    const acme = gridRow();
    const { container } = await openAdmin("/", {
      fetchClientGrid: [acme],
      fetchClientAdmins: [
        answeredAdmin({
          client: acme,
          billing: { state: "read", customerId, account: late },
        }),
      ],
      fetchClientSummaries: [
        answeredSummary({
          client: acme,
          billing: { state: "read", customerId, account: late },
        }),
      ],
    });
    const inbox = [
      ...container.querySelectorAll<HTMLElement>('[role="tab"]'),
    ].find((tab) => tab.textContent?.includes("Inbox"));
    await act(() => {
      inbox?.click();
    });
    await settle();
    const overdue = [
      ...container.querySelectorAll('[data-slot="sidebar"] a'),
    ].find((link) => link.textContent?.includes("is overdue"));

    expect(overdue?.getAttribute("href")).toBe(
      `/organizations/${acme.id}/details?tab=contract`
    );
  });

  it("shows an overdue invoice in Billing and among what needs Grasp", async () => {
    const { contract, lines, invoices, overview } = await opened({
      state: "read",
      customerId,
      account: late,
    });

    expect({
      line: contract.includes("1 invoice is overdue, €1,815.00 in all."),
      pays: lines["How it pays"],
      open: lines.Open,
      overdue: lines.Overdue,
      invoice: /NK-0003.*?Overdue/su.test(invoices ?? ""),
      need: overview.includes(
        `An invoice of €1,815.00 is overdue: it was due on ${formatDate(day(-10))}.`
      ),
    }).toStrictEqual({
      line: true,
      pays: "It is sent each invoice, to pay within 14 days",
      open: "€1,815.00, 1 invoice",
      overdue: `€1,815.00, due since ${formatDate(day(-10))}`,
      invoice: true,
      need: true,
    });
  });

  it("says a company not linked yet isn't, offers to link it, and shows no invoices", async () => {
    const { contract, field, invoices } = await opened({ state: "not_linked" });

    expect({
      line: contract.includes(
        "Not linked to its customer in Stripe yet. Link it by the customer’s id, and this fills in by itself."
      ),
      form: field,
      invoices,
    }).toStrictEqual({ line: true, form: "", invoices: null });
  });

  it("says Stripe isn't connected, keeps the customer it is linked to, and says nothing is overdue", async () => {
    const { contract, field, overview } = await opened({
      state: "not_connected",
      customerId,
    });

    expect({
      line: contract.includes(
        "Once Stripe is connected, this fills in by itself. Add STRIPE_RESTRICTED_KEY to the stage’s 1Password Environment, then run Deploy platform."
      ),
      linkedTo: field,
      overdue: overview.includes("overdue"),
    }).toStrictEqual({ line: true, linkedTo: customerId, overdue: false });
  });
});
