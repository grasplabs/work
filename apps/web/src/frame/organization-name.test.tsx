// @vitest-environment happy-dom

import type { Organization } from "@grasp-os/shared/organization";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import {
  organizationRenamed,
  OrganizationNameOf,
} from "./organization-name.tsx";

// The organization's name in the sidebar against core's answer to its read of the
// organization, faked: the organization's name once core says it;
// "Grasp" when it has none or core can't say.

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
  logo: null,
});

/** Lets everything already settled run: core's answer, and React's render of it. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

/**
 * The name shown once core answered `organization`'s read, and
 * `then` (a rename on the page, say) ran.
 */
const textWith = async (
  organization: () => Promise<Organization>,
  then?: () => void
): Promise<string> => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterContextProvider router={router}>
          <OrganizationNameOf organization={organization} />
        </RouterContextProvider>
      </I18nProvider>
    );
    await settled();
  });
  if (then !== undefined) {
    act(then);
  }
  const text =
    host.querySelector('[data-slot="organization-name"]')?.textContent ?? "";
  act(() => {
    root.unmount();
  });
  host.remove();
  return text;
};

describe("the organization's name in the sidebar", () => {
  it("names the organization once core says it, and its new name once renamed, and says Grasp alone when it has none or core can't say", async () => {
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
      renamed: await textWith(
        async () => {
          await settled();
          return organizationNamed("Noordkade Finance");
        },
        () => {
          organizationRenamed("Noordkade Group");
        }
      ),
      // Renamed while the read is still out: its older answer doesn't undo it.
      renamedFirst: await textWith(async () => {
        organizationRenamed("Noordkade Group");
        await settled();
        return organizationNamed("Noordkade Finance");
      }),
      // A name mounted anew, its read still out: nothing of the names
      // shown before it.
      mountedAgain: await textWith(
        async () => await Promise.withResolvers<Organization>().promise
      ),
    }).toStrictEqual({
      named: "Noordkade Finance",
      unnamed: "Grasp",
      unanswered: "Grasp",
      renamed: "Noordkade Group",
      renamedFirst: "Noordkade Group",
      mountedAgain: "Grasp",
    });
  });
});
