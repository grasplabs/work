// @vitest-environment happy-dom
import { agentErrors } from "@grasp-os/shared/agent";
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

import { ChatAccountsSection } from "./chat-accounts.tsx";

// Settings › Security › Chat apps › Your conversations in chat apps: the
// person deletes what Grasp keeps of their conversations with Stephen in
// chat apps (`channelAccounts.forgetConversations`), against core's API as
// the page reaches it over RPC, faked to answer as `answer` says.

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

/** The section, with core answering a delete as `answer` does; how often it was asked. */
const shown = async (answer: () => Promise<number>) => {
  const asked: number[] = [];
  const session = {
    channelAccounts: {
      forgetConversations: async (): Promise<number> => {
        asked.push(asked.length + 1);
        return await answer();
      },
    },
  };
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ChatAccountsSection
        chat={{ state: "ready", data: { reach: [], accounts: [] } }}
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
  await settled();
  return asked;
};

const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (button === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

const text = (): string => document.body.textContent ?? "";

describe("Settings › Security › Chat apps › Your conversations in chat apps", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("deletes them only once the person confirms, and says how many went", async () => {
    const asked = await shown(async () => await Promise.resolve(2));

    await press("Delete");
    const beforeConfirming = [...asked];
    await press("Delete for good");

    expect({
      beforeConfirming,
      asked,
      said: text().includes("2 conversations deleted."),
    }).toStrictEqual({ beforeConfirming: [], asked: [1], said: true });
  });

  it("says one is still being answered, in the page's words, when one is", async () => {
    await shown(async () => {
      await Promise.resolve();
      throw agentErrors.create("agent.conversation_answering");
    });

    await press("Delete");
    await press("Delete for good");

    expect({
      answering: text().includes(
        "Stephen is still answering one of your conversations. Try again in a moment."
      ),
      deleted: text().includes("deleted."),
    }).toStrictEqual({ answering: true, deleted: false });
  });

  it("shows why core refused it otherwise", async () => {
    await shown(async () => {
      await Promise.resolve();
      throw agentErrors.create("agent.chat_not_found");
    });

    await press("Delete");
    await press("Delete for good");

    expect(text()).toContain(
      agentErrors.create("agent.chat_not_found").message
    );
  });
});
