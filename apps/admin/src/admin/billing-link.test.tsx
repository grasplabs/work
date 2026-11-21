// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it } from "vite-plus/test";

import { answeredAdmin, gridRow, openAdmin, settle } from "../../test/app.tsx";
import type { ClientAdmin } from "../clients/admin.ts";

// A Stripe customer staff link on an organization's page shows linked once the
// change is through, within the minute its last answer stands: the page
// asks its core again for what it changed, never shows the answer from
// before (src/admin/org-loads.ts, `readOrganization`).

const acme = gridRow({ id: "acme", name: "Acme" });

/** Acme's core answering `before` until `changed` says the change went through, then `after`. */
const answering = (before: ClientAdmin, after: ClientAdmin) => {
  let changed = false;
  return {
    change: () => {
      changed = true;
    },
    admin: () => (changed ? after : before),
  };
};

/** Submits `form` as pressing its button does. */
const submit = async (form: Element | null | undefined): Promise<void> => {
  if (form === null || form === undefined) {
    throw new Error("No such form");
  }
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await Promise.resolve();
  });
  await settle();
};

describe("linking an organization to its Stripe customer", () => {
  it("shows a linked company's billing once it is linked to its Stripe customer, though the page's answer was a moment old", async () => {
    const customerId = "cus_Acme1";
    const core = answering(
      answeredAdmin({ client: acme }),
      answeredAdmin({
        client: acme,
        billing: {
          state: "read",
          customerId,
          account: {
            name: "Acme B.V.",
            url: `https://dashboard.stripe.com/test/customers/${customerId}`,
            pays: { by: "charge" },
            subscription: null,
            open: { count: 0, amount: [] },
            overdue: { count: 0, amount: [], since: null },
            lastPaid: null,
            invoices: [],
          },
        },
      })
    );
    const { container } = await openAdmin(
      "/organizations/acme/details?tab=contract",
      {
        fetchClientGrid: [acme],
        fetchClientAdmin: core.admin,
        fetchClientAdmins: [],
        setStripeCustomerFn: () => {
          core.change();
          return { changed: true, refused: null };
        },
      }
    );
    const billing = () =>
      container.querySelector("#contract-billing")?.textContent ?? "";
    const before = billing();

    const field = container.querySelector<HTMLInputElement>(
      'input[name="customerId"]'
    );
    if (field !== null) {
      field.value = customerId;
    }
    await submit(field?.closest("form"));

    expect({
      before: before.includes("Not linked to its customer in Stripe yet."),
      after: billing().includes("Everything billed is paid."),
    }).toStrictEqual({ before: true, after: true });
  });
});
