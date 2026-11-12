// @vitest-environment happy-dom
import type {
  DependencyDecision,
  DependencyRequest,
} from "@grasp-os/shared/dependencies";
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

import { PackageRequests } from "./package-requests.tsx";

// The npm packages a chat's agent asked for, against core's chats and
// dependencies as the page reaches them over RPC, faked: approving them
// carries the work on (the agent's turn ended asking), denying them
// doesn't, and neither does an approval core refuses.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const request: DependencyRequest = {
  id: "request-1",
  subject: { type: "app", id: "app-1", name: "Invoice Manager" },
  status: "pending",
  purpose: "Format the invoice dates",
  graphHash: "a".repeat(64),
  lock: {
    lockfileVersion: 2,
    registry: "https://registry.npmjs.org",
    requested: { "date-fns": "^4.1.0" },
    direct: { "date-fns": "4.1.0" },
    entries: ["date-fns"],
    packages: {
      "date-fns@4.1.0": {
        name: "date-fns",
        version: "4.1.0",
        integrity: `sha512-${"A".repeat(86)}==`,
        license: "MIT",
        publishedAt: "2024-09-17T00:00:00.000Z",
        dependencies: {},
      },
    },
  },
  removed: [],
  findings: [],
  requestedBy: { userId: "user-1", name: "Sanne de Wit" },
  requestedAt: "2026-11-11T10:00:00.000Z",
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The chat's package card against a core that refuses decisions when `refuse` says so. */
const shown = async (refuse = false) => {
  const decided: { approved: boolean }[] = [];
  let carriedOn = 0;
  const session = {
    chats: {
      packageRequests: async (): Promise<DependencyRequest[]> =>
        await Promise.resolve(decided.length === 0 ? [request] : []),
    },
    dependencies: {
      decide: async (
        _id: string,
        decision: DependencyDecision
      ): Promise<DependencyRequest> => {
        await Promise.resolve();
        if (refuse) {
          throw new Error("Someone decided meanwhile.");
        }
        decided.push({ approved: decision.approved });
        return request;
      },
    },
  };
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <PackageRequests
          chatId="chat-1"
          onApproved={() => {
            carriedOn += 1;
          }}
          version={0}
        />
      ),
    }),
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
  return { decided, carriedOn: () => carriedOn };
};

const press = async (label: string): Promise<void> => {
  const button = document.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

describe("the chat's package requests", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("carries the work on once the packages are approved", async () => {
    const { decided, carriedOn } = await shown();

    await press("Approve the packages for Invoice Manager");

    expect({ decided, carriedOn: carriedOn() }).toStrictEqual({
      decided: [{ approved: true }],
      carriedOn: 1,
    });
  });

  it("carries nothing on when the packages are denied, or the approval is refused", async () => {
    const denied = await shown();
    await press("Deny the packages for Invoice Manager");
    const deniedOn = denied.carriedOn();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const refused = await shown(true);
    await press("Approve the packages for Invoice Manager");

    expect({
      denied: denied.decided,
      deniedOn,
      refusedOn: refused.carriedOn(),
    }).toStrictEqual({
      denied: [{ approved: false }],
      deniedOn: 0,
      refusedOn: 0,
    });
  });
});
