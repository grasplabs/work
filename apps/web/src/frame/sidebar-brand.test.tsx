// @vitest-environment happy-dom
import type { Organization } from "@grasp-os/shared/organization";
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { SidebarBrandOf } from "./sidebar-brand.tsx";

// The sidebar's header against core's answer to its read of the
// organization, faked: the organization's name over "Grasp" once core
// says it, as the prototype's; "Grasp" alone when it has none or core
// can't say.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory(),
});

const organizationNamed = (name: string): Organization => ({
  name,
  timeZone: "Europe/Amsterdam",
  dataRegion: "eu",
  signInDomains: [],
});

/** Lets everything already settled run: core's answer, and React's render of it. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

/** The header's lines of text once core answered `organization`'s read. */
const textWith = async (
  organization: () => Promise<Organization>
): Promise<string> => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <RouterContextProvider router={router}>
        <SidebarProvider>
          <SidebarBrandOf organization={organization} />
        </SidebarProvider>
      </RouterContextProvider>
    );
    await settled();
  });
  // Each line of the header on its own: its name, then "Grasp".
  const text = [...host.querySelectorAll("span")]
    .filter((span) => span.children.length === 0)
    .map((span) => span.textContent.trim())
    .filter((line) => line !== "")
    .join(" ");
  act(() => {
    root.unmount();
  });
  host.remove();
  return text;
};

describe("the sidebar's header", () => {
  it("names the organization over Grasp once core says it, and says Grasp alone when it has none or core can't say", async () => {
    expect({
      named: await textWith(async () => {
        await settled();
        return organizationNamed("Noordkade Finance");
      }),
      unnamed: await textWith(async () => {
        await settled();
        return organizationNamed("  ");
      }),
      unanswered: await textWith(async () => {
        await settled();
        throw new Error("Core couldn't say just now.");
      }),
    }).toStrictEqual({
      named: "Noordkade Finance Grasp",
      unnamed: "Grasp",
      unanswered: "Grasp",
    });
  });
});
