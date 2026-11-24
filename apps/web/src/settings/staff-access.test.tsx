// @vitest-environment happy-dom
import type { GateView } from "@grasp-os/shared/onboarding-gate";
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

import { StaffAccessSection } from "./staff-access.tsx";

// Settings › Workspace › Grasp staff access against core's onboarding gate
// as the page reaches it over RPC (the boundary from the web app), faked:
// ending staff access closes the window it reports, and the page's next
// read answers with that, so what the page shows after is what core holds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const until = "2026-11-02T17:00:00.000Z";

/** Core's gate, with the staff window `staff`, and each end asked. */
const fakeGate = (staff: GateView["staff"]) => {
  const asked: string[] = [];
  let current = staff;
  const onboardingGate = {
    staff: async (): Promise<GateView["staff"]> => {
      await Promise.resolve();
      return current;
    },
    endStaffAccess: async (): Promise<void> => {
      await Promise.resolve();
      asked.push("end");
      current = current === null ? null : { ...current, open: false };
    },
  };
  return { session: { onboardingGate }, asked };
};

let root: Root | undefined;

/** The section on what `session` holds, for the company's admin when `editable`. */
const shown = async (
  session: ReturnType<typeof fakeGate>["session"],
  editable = true
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({
    loader: async () => await session.onboardingGate.staff(),
    component: () => (
      <StaffAccessSection
        editable={editable}
        staff={rootRoute.useLoaderData()}
      />
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
};

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

const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );

const press = async (name: string) => {
  const found = button(name);
  if (found === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

const text = (): string => document.body.textContent ?? "";

describe("Settings › Workspace › Grasp staff access", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("shows the admin that staff can sign in, and ends it only once they confirm", async () => {
    const { session, asked } = fakeGate({
      open: true,
      scope: "onboarding",
      until,
    });
    await shown(session);
    expect(text()).toContain("They reach the onboarding alone.");

    await press("End staff access now");
    await press("Cancel");
    const afterCancel = [...asked];
    await press("End staff access now");
    await press("End access");

    expect({ afterCancel, asked }).toStrictEqual({
      afterCancel: [],
      asked: ["end"],
    });
    expect(text()).toContain(
      "Nobody from Grasp can sign in to this workspace now."
    );
    expect(button("End staff access now")).toBeUndefined();
  });

  it("says nobody from Grasp can sign in when no window is open", async () => {
    const { session } = fakeGate(null);
    await shown(session);

    expect({
      none: text().includes(
        "Nobody from Grasp can sign in to this workspace now."
      ),
      end: button("End staff access now"),
    }).toStrictEqual({ none: true, end: undefined });
  });

  it("shows Grasp staff their own access, with no way to end it", async () => {
    const { session } = fakeGate({ open: true, scope: "full", until });
    await shown(session, false);

    expect({
      reach: text().includes("They reach everything their role allows."),
      end: button("End staff access now"),
    }).toStrictEqual({ reach: true, end: undefined });
  });
});
