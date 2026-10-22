// @vitest-environment happy-dom
import type { ChatDraft, ChatDraftVersion } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DraftVersionBar, shownVersion } from "./draft-versions.tsx";
import type { ShownVersion } from "./draft-versions.tsx";

// "Version N of M" in the studio, against core's chats as the page reaches
// them over RPC, faked: it counts the draft's versions, steps back to an
// earlier one, which reads as read-only, and returns to the latest; a new
// write of the draft brings the person back to the latest; versions that
// don't load leave the count out.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const draftAt = (revision: number, app = "app-1"): ChatDraft => ({
  app,
  base: 1,
  changed: ["screens/desk.tsx"],
  deleted: [],
  revision,
  updatedAt: "2026-10-22T10:00:00.000Z",
  callId: null,
});

/** `count` versions of the draft, newest first, the newest at `revision`. */
const versionsUpTo = (count: number, revision: number): ChatDraftVersion[] =>
  Array.from({ length: count }, (_, at) => ({
    number: count - at,
    revision: revision - at,
    base: 1,
    contentHash: `hash-${count - at}`,
    callId: "call-1",
    restoredFrom: null,
    createdAt: "2026-10-22T10:00:00.000Z",
  }));

/**
 * The studio's bar for the draft, holding which version is open as the
 * studio does; the draft and what core answers can change after.
 */
const shown = async (answer: () => ChatDraftVersion[]) => {
  const asked: string[] = [];
  const chats = {
    draftVersions: async (chatId: string, app: string) => {
      await Promise.resolve();
      asked.push(`${chatId}:${app}`);
      return answer();
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  // The agent's next write, as the studio hears of it: the draft's next
  // revision.
  const Studio = () => {
    const [draft, setDraft] = useState(draftAt(2));
    const [open, setOpen] = useState<ShownVersion>();
    const version = shownVersion(draft, open);
    return (
      <>
        <button
          onClick={() => {
            setDraft(draftAt(draft.revision + 1, draft.app));
          }}
          type="button"
        >
          Agent writes
        </button>
        <button
          onClick={() => {
            setDraft(
              draftAt(draft.revision, draft.app === "app-1" ? "app-2" : "app-1")
            );
          }}
          type="button"
        >
          Switch app
        </button>
        <DraftVersionBar
          chatId="chat-1"
          draft={draft}
          onShow={(number) => {
            setOpen(
              number === undefined
                ? undefined
                : { app: draft.app, revision: draft.revision, number }
            );
          }}
          shown={version}
        />
      </>
    );
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Studio,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
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
  return { asked };
};

/** The harness's own buttons: what the studio around the bar does. */
const harness = new Set(["Agent writes", "Switch app"]);

/** The harness's buttons' text, which comes first on the page. */
const harnessText = /^Agent writesSwitch app/u;

/** The bar's buttons, but the harness's own. */
const barButtons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")].filter(
    (button) => !harness.has(button.textContent)
  );

/** What the bar says, and which of its buttons are enabled. */
const bar = () => ({
  text: document.body.textContent.replace(harnessText, ""),
  enabled: barButtons()
    .filter((button) => !button.disabled)
    .map((button) => button.getAttribute("aria-label") ?? button.textContent),
});

/** Presses the button labelled (or named) `label`. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === label || each.textContent === label
  );
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
};

describe(DraftVersionBar, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("counts the draft's versions, opens an earlier one read-only, and returns to the latest", async () => {
    let versions = versionsUpTo(3, 2);
    const { asked } = await shown(() => versions);
    const latest = bar();

    await press("Earlier version");
    await press("Earlier version");
    const first = bar();
    await press("Later version");
    const second = bar();
    await press("Back to latest");
    const back = bar();
    await press("Earlier version");
    // The agent writes again: the new version shows, the latest.
    versions = versionsUpTo(4, 3);
    await press("Agent writes");
    const written = bar();

    expect({ latest, first, second, back, written, asked }).toStrictEqual({
      latest: {
        text: "Version 3 of 3",
        enabled: ["Earlier version"],
      },
      first: {
        text: "Version 1 of 3Read-onlyBack to latest",
        enabled: ["Later version", "Back to latest"],
      },
      second: {
        text: "Version 2 of 3Read-onlyBack to latest",
        enabled: ["Earlier version", "Later version", "Back to latest"],
      },
      back: {
        text: "Version 3 of 3",
        enabled: ["Earlier version"],
      },
      written: {
        text: "Version 4 of 4",
        enabled: ["Earlier version"],
      },
      asked: ["chat-1:app-1", "chat-1:app-1"],
    });
  });

  it("keeps the way back to the latest when the versions don't load while an earlier one is open", async () => {
    let reads = 0;
    await shown(() => {
      reads += 1;
      if (reads > 1) {
        throw new Error("Core is out of reach");
      }
      return versionsUpTo(3, 2);
    });

    await press("Earlier version");
    // Away to another App's draft and back: both reads fail.
    await press("Switch app");
    await press("Switch app");
    const unread = bar();
    await press("Back to latest");

    expect({ unread, back: bar() }).toStrictEqual({
      unread: { text: "Read-onlyBack to latest", enabled: ["Back to latest"] },
      back: { text: "", enabled: [] },
    });
  });

  it("leaves the count out when the versions don't load", async () => {
    await shown(() => {
      throw new Error("Core is out of reach");
    });

    expect(bar()).toStrictEqual({ text: "", enabled: [] });
  });
});
