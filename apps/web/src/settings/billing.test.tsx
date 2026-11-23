// @vitest-environment happy-dom
import {
  billingSettingsSchema,
  noBilling,
} from "@grasp-os/shared/org-settings";
import type {
  BillingSettings as Billing,
  BillingSettingsInput,
} from "@grasp-os/shared/org-settings";
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

import { BillingSettings } from "./billing.tsx";

// Settings › Billing against core's `orgSettings` as the page reaches it
// over RPC, faked as core keeps billing: whole, each save replacing what
// was there. A save can be held on its way, so a person goes on changing
// things while an earlier change is still being saved.

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

/** Core's billing: what it keeps, and the saves held on their way while `holding`. */
const fakeCore = () => {
  const held: (() => void)[] = [];
  const state: { kept: Billing; holding: boolean } = {
    kept: noBilling,
    holding: false,
  };
  const orgSettings = {
    billing: async (): Promise<Billing> => {
      await Promise.resolve();
      return state.kept;
    },
    updateBilling: async (input: BillingSettingsInput): Promise<Billing> => {
      const next = billingSettingsSchema.parse(input);
      if (state.holding) {
        const { promise, resolve } = Promise.withResolvers<boolean>();
        held.push(() => {
          resolve(true);
        });
        await promise;
      }
      state.kept = next;
      return next;
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { orgSettings: typeof orgSettings }) => Promise<T>
    ): Promise<T> => await action({ orgSettings }),
  };
  /** Holds no more saves, and lets the held ones through. */
  const release = async (): Promise<void> => {
    state.holding = false;
    for (const go of held.splice(0)) {
      go();
    }
    await settled();
  };
  return { core, orgSettings, release, state };
};

const shown = async ({
  core,
  orgSettings,
}: Pick<ReturnType<typeof fakeCore>, "core" | "orgSettings">) => {
  const rootRoute = createRootRoute({
    loader: async () => await orgSettings.billing(),
    component: () => (
      <BillingSettings billing={rootRoute.useLoaderData()} readOnly={false} />
    ),
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
};

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The words an element is named by: its own label, or what labels it. */
const nameOf = (element: Element): string => {
  const ids = element.getAttribute("aria-labelledby")?.split(" ");
  const labels =
    ids === undefined
      ? [...document.querySelectorAll(`label[for="${element.id}"]`)]
      : ids.map((id) => document.querySelector(`[id="${id}"]`));
  return (
    element.getAttribute("aria-label") ??
    labels.map((each) => each?.textContent.trim() ?? "").join(" ")
  ).trim();
};

/** The switch named `name`. */
const switchNamed = (name: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="switch"]'),
  ].find((each) => nameOf(each) === name);
  if (found === undefined) {
    throw new TypeError(`No switch ${name}`);
  }
  return found;
};

/** An element's words as people get them: not the ones it hides from them. */
const wordsOf = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent.trim();
};

/** The button whose words are `name`. */
const button = (name: string, within: ParentNode = document) => {
  const found = [...within.querySelectorAll("button")].find(
    (each) => wordsOf(each) === name
  );
  if (found === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  return found;
};

/** Types `value` into the dialog's field named `name`, as React hears a person type it. */
const enter = async (name: string, value: string): Promise<void> => {
  const field = [
    ...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input'),
  ].find((each) => nameOf(each) === name);
  if (field === undefined) {
    throw new TypeError(`No field ${name}`);
  }
  await act(async () => {
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

describe("Settings › Billing", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("keeps a switch flipped before the details, the details, and a switch flipped after them, though core keeps billing whole", async () => {
    const fake = fakeCore();
    await shown(fake);

    // Each save is still on its way while the next change is made.
    fake.state.holding = true;
    await press(switchNamed("Email invoices"));
    await press(button("Edit billing information"));
    await enter("Company", "Acme Billing B.V.");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog === null) {
      throw new TypeError("No dialog");
    }
    await press(button("Save", dialog));
    await press(switchNamed("Email payment receipts"));
    await fake.release();

    expect(fake.state.kept).toStrictEqual({
      ...noBilling,
      company: "Acme Billing B.V.",
      emailInvoices: true,
      emailReceipts: true,
    });
    // As core keeps them, on the card and the switches.
    expect(document.body.textContent).toContain("Acme Billing B.V.");
    expect(switchNamed("Email invoices").getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(
      switchNamed("Email payment receipts").getAttribute("aria-checked")
    ).toBe("true");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
