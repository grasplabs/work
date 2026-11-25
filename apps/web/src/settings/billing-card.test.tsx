// @vitest-environment happy-dom
import type { BillingSettings } from "@grasp-os/shared/org-settings";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BillingCard } from "./billing-card.tsx";
import { useQueuedSave } from "./queued-save.ts";

// Settings › Billing as its page puts it together: the billing details'
// card and its dialog, and a billing email's switch, every change saved
// whole through one queue, against core's `orgSettings` as the page
// reaches it over RPC, faked: it keeps what it is sent, and the page's
// next read answers with it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** What core keeps of the billing details, as the page read them first. */
const first: BillingSettings = {
  company: "Acme",
  address: null,
  vatNumber: null,
  email: null,
  emailInvoices: false,
  emailReceipts: false,
};

/** The card and an Email invoices switch on `billing`, saved through the one queue. */
const Page = ({ billing }: { billing: BillingSettings }) => {
  const { save } = useQueuedSave(billing, async (session, next) => {
    await session.orgSettings.updateBilling(next);
  });
  return (
    <>
      <BillingCard billing={billing} canChange save={save} />
      <button
        onClick={() => {
          void save({ emailInvoices: !billing.emailInvoices });
        }}
        type="button"
      >
        Email invoices
      </button>
    </>
  );
};

/** The page on what `kept` holds. */
const shown = async (): Promise<{ kept: () => BillingSettings }> => {
  let kept = first;
  const orgSettings = {
    billing: async (): Promise<BillingSettings> => await Promise.resolve(kept),
    updateBilling: async (next: BillingSettings): Promise<void> => {
      await Promise.resolve();
      kept = next;
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { orgSettings: typeof orgSettings }) => Promise<T>
    ): Promise<T> => await action({ orgSettings }),
  };
  const rootRoute = createRootRoute({
    loader: async () => await orgSettings.billing(),
    component: () => <Page billing={rootRoute.useLoaderData()} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
  return { kept: () => kept };
};

/** An element's words as a screen reader hears them: what is hidden from it left out. */
const wordsOf = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return copy.textContent?.trim() ?? "";
};

const press = async (words: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].findLast(
    (each) => wordsOf(each) === words
  );
  if (button === undefined) {
    throw new TypeError(`No button ${words}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

/** Types `value` into the open dialog's Company field. */
const company = async (value: string): Promise<void> => {
  const input = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input'
  );
  if (input === null) {
    throw new TypeError("No Company field");
  }
  await act(async () => {
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

describe("Settings › Billing", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("keeps details saved in the dialog when a billing email is switched after them", async () => {
    const { kept } = await shown();

    await press("Email invoices");
    await press("Edit billing information");
    await company("Acme BV");
    await press("Save");
    await press("Email invoices");

    expect({
      company: kept().company,
      emailInvoices: kept().emailInvoices,
    }).toStrictEqual({ company: "Acme BV", emailInvoices: false });
  });
});
