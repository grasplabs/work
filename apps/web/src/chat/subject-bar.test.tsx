// @vitest-environment happy-dom
import type { ChatWork } from "@grasp-os/shared/chat";
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

import type { NamedWork } from "./builds.tsx";
import { SubjectBarContent } from "./subject-bar.tsx";

// What the chat is about and what it worked on, on the bar above its box:
// the page's subject, or else the App it changed last, a way into its
// workspace; the rest behind "+N", the latest first, each a way into its
// own; building only where the running turn wrote its draft.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** App `app`, named `name`, whose draft the chat last wrote at `updatedAt`. */
const drafted = (app: string, name: string, updatedAt: string): NamedWork => {
  const work: ChatWork = { kind: "app", id: app, updatedAt, callId: null };
  return { work, name };
};

const drafts = [
  drafted("app-ledger", "Ledger", "2026-11-08T09:00:00.000Z"),
  drafted("app-intake", "Intake", "2026-11-08T11:00:00.000Z"),
  drafted("app-desk", "Desk", "2026-11-08T10:00:00.000Z"),
];

let root: Root | undefined;

const shown = async (
  subject: { kind: "app"; id: string; name: string } | undefined,
  worked: NamedWork[],
  since?: string
) => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <div data-slot="prompt-input-subject-bar">
          <SubjectBarContent
            chatId="chat-1"
            work={worked}
            since={since}
            subject={subject}
          />
        </div>
      ),
    }),
    history: createMemoryHistory(),
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

const bar = (): Element => {
  const found = document.querySelector(
    '[data-slot="prompt-input-subject-bar"]'
  );
  if (found === null) {
    throw new Error("No bar");
  }
  return found;
};

/** The bar's line: its link or name, and what it says beside it. */
const line = () => ({
  text: [...bar().children]
    .filter((each) => each.tagName !== "BUTTON" && each.tagName !== "svg")
    .map((each) => each.textContent),
  href: bar().querySelector(":scope > a")?.getAttribute("href") ?? null,
  more: bar().querySelector("button")?.textContent ?? null,
});

/** Opens "+N" and reads what it lists: each by name and where it goes. */
const listed = async () => {
  const more = bar().querySelector("button");
  if (more === null) {
    throw new Error("Nothing more");
  }
  await act(async () => {
    more.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    more.click();
    await Promise.resolve();
  });
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => ({
    name: item.textContent,
    href: item.getAttribute("href"),
  }));
};

describe(SubjectBarContent, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("leads with the App the chat changed last, building where the running turn wrote it, and lists the rest behind +N, latest first", async () => {
    await shown(undefined, drafts, "2026-11-08T10:30:00.000Z");
    const first = line();

    expect({ first, rest: await listed() }).toStrictEqual({
      first: {
        text: ["Intake", "Building…"],
        href: "/apps/app-intake?chat=chat-1",
        more: "+2",
      },
      rest: [
        { name: "Desk", href: "/apps/app-desk?chat=chat-1" },
        { name: "Ledger", href: "/apps/app-ledger?chat=chat-1" },
      ],
    });
  });

  it("shows nothing building while the running turn has written no App", async () => {
    await shown(undefined, drafts, "2026-11-08T12:00:00.000Z");

    expect(line()).toStrictEqual({
      text: ["Intake"],
      href: "/apps/app-intake?chat=chat-1",
      more: "+2",
    });
  });

  it("leads with the page's subject, not a link, and lists the rest of what the chat worked on", async () => {
    await shown({ kind: "app", id: "app-desk", name: "Desk" }, drafts);
    const first = line();

    expect({ first, rest: await listed() }).toStrictEqual({
      first: { text: ["Desk"], href: null, more: "+2" },
      rest: [
        { name: "Intake", href: "/apps/app-intake?chat=chat-1" },
        { name: "Ledger", href: "/apps/app-ledger?chat=chat-1" },
      ],
    });
  });

  it("shows the subject alone where the chat worked on nothing else", async () => {
    await shown({ kind: "app", id: "app-desk", name: "Desk" }, []);

    expect(line()).toStrictEqual({ text: ["Desk"], href: null, more: null });
  });
});
