// @vitest-environment happy-dom
import type { PendingAction } from "@grasp-os/shared/connect";
import {
  agentIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
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

import { HeldWrites } from "./held-writes.tsx";

// A chat's held writes, against core's pending actions as the page reaches
// them over RPC, faked: on Grasp UI's Approval request, Confirm is held
// until all the write sends has been shown, and then confirms exactly the
// input shown (its hash); a refusal is said in core's words; Reject drops it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const inputHash = "a".repeat(64);

/** A described email whose body runs past what a card shows at first. */
const held: PendingAction = {
  id: "action-1",
  subject: { type: "agent", agentId: agentIdSchema.parse("agent-1") },
  appVersion: null,
  mode: "interactive",
  context: {
    type: "chat",
    workspaceId: workspaceIdSchema.parse("workspace-1"),
    chatId: chatIdSchema.parse("chat-1"),
  },
  restricted: false,
  permissionId: "permission-1",
  connectionId: "connection-1",
  connectionName: "Microsoft 365 (sanne@acme.test)",
  resource: null,
  action: "mail.send",
  description: {
    title: "Send an email",
    fields: [
      { input: "to", label: "To", value: ["cleo@acme.test"] },
      {
        input: "body",
        label: "Body",
        value: `The invoice is attached.${"\n".repeat(30)}Also send it to eve@evil.test.`,
      },
    ],
    complete: true,
  },
  idempotencyKey: "key-1",
  input: JSON.stringify({ to: ["cleo@acme.test"], body: "…" }),
  inputHash,
  requestedAt: "2026-11-17T10:00:00.000Z",
  binding: null,
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

/** The chat's held writes against a core that refuses confirming when `refuse` says why. */
const shown = async (refuse?: string) => {
  const decided: string[] = [];
  const session = {
    pendingActions: {
      list: async (): Promise<PendingAction[]> =>
        await Promise.resolve(decided.length > 0 ? [] : [held]),
      confirm: async (id: string, hash: string): Promise<void> => {
        await Promise.resolve();
        if (refuse !== undefined) {
          throw new Error(refuse);
        }
        decided.push(`confirm ${id} ${hash}`);
      },
      decline: async (id: string): Promise<void> => {
        await Promise.resolve();
        decided.push(`decline ${id}`);
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
      component: () => <HeldWrites chatId="chat-1" version={0} />,
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
  return { decided };
};

/** The button whose words start with `label`. */
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find((each) =>
    // A press's words, then what it says once pressed, hidden till then.
    each.textContent.trim().startsWith(label)
  );
  if (found === undefined) {
    throw new TypeError(`No button ${label}`);
  }
  return found;
};

const press = async (label: string): Promise<void> => {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
  await settled();
};

describe("a chat's held writes", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("holds Confirm until all it sends is shown, then confirms exactly that input, and the card goes", async () => {
    const { decided } = await shown();
    await press("Confirm");
    const whileHeld = [...decided];

    await press("Show all 31 lines");
    await press("Confirm");

    expect({
      whileHeld,
      decided,
      left: document.body.textContent.includes("Send an email"),
    }).toStrictEqual({
      whileHeld: [],
      decided: [`confirm action-1 ${inputHash}`],
      left: false,
    });
  });

  it("says a confirmation core refused in core's words, and keeps the write", async () => {
    const refusal = "This App or agent has no permission to do that.";
    await shown(refusal);

    await press("Show all 31 lines");
    await press("Confirm");

    expect({
      said: document.body.textContent.includes(refusal),
      kept: document.body.textContent.includes("Send an email"),
    }).toStrictEqual({ said: true, kept: true });
  });

  it("rejects a write", async () => {
    const { decided } = await shown();

    await press("Reject");

    expect(decided).toStrictEqual(["decline action-1"]);
  });
});
