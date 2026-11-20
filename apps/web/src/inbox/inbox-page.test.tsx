// @vitest-environment happy-dom
import type { Gap } from "@grasp-os/shared/brain";
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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { PagePanelProvider, usePagePanelSlot } from "../frame/page-panel.tsx";
import { AppShell } from "../grasp/app-shell/index.ts";
import type { Loaded } from "../load-from-core.tsx";
import { InboxPage } from "./inbox-page.tsx";
import { inboxItems } from "./items.ts";
import type { Waiting } from "./waiting.ts";

// The Inbox in the product's shell (Grasp UI's App shell, given the page's
// panel as the frame gives it): the item to decide stands in the shell's
// page panel beside the list on a wide card and opens as the shell's sheet
// on a phone; J and K walk what waits; an item that is settled leaves and
// the one after it opens. Core's brain is faked as the page reaches it over RPC.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const gapOf = (id: string, question: string): Gap => ({
  id,
  question,
  owner: "Head of finance",
  sourceId: "src-1",
  about: [],
});

const three = (): Gap[] => [
  gapOf("gap-1", "Who approves a refund?"),
  gapOf("gap-2", "Who pays the invoices?"),
  gapOf("gap-3", "Who signs a quote?"),
];

/** The product's frame round the page: App shell, with the page's panel in its slot. */
const Frame = ({ children }: { children: ReactNode }) => {
  const pagePanel = usePagePanelSlot();
  return (
    <AppShell bar="page" sidebar={undefined} {...pagePanel.shell}>
      <PagePanelProvider value={pagePanel.frame}>{children}</PagePanelProvider>
    </AppShell>
  );
};

/** The width a `(min-width: Nrem)` query asks about. */
const minWidth = /^\(min-width:\s*(?<at>[\d.]+)rem\)$/u;

/**
 * A window `width` wide, and a card as wide: happy-dom lays nothing out, so
 * the width queries the page asks about and the card's own box say it.
 */
const windowOf = (width: number): void => {
  vi.stubGlobal("matchMedia", (query: string) => {
    const at = Number(minWidth.exec(query)?.groups?.at) * 16;
    return Object.assign(new EventTarget(), {
      matches: width >= at,
      media: query,
    });
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, width, 900)
  );
};

/** A held email from a chat, as its tool describes it. */
const heldEmail: PendingAction = {
  id: "write-1",
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
  connectionName: "Microsoft 365 (ada@acme.test)",
  resource: "ada@acme.test",
  action: "mail.send",
  description: {
    title: "Send an email",
    fields: [
      { input: "mailbox", label: "From", value: "ada@acme.test" },
      { input: "to", label: "To", value: ["cleo@acme.test"] },
      { input: "subject", label: "Subject", value: "Refunds" },
      { input: "body", label: "Body", value: "Who approves a refund?" },
    ],
    complete: true,
  },
  idempotencyKey: "key-1",
  input: JSON.stringify({
    mailbox: "ada@acme.test",
    to: ["cleo@acme.test"],
    subject: "Refunds",
    body: "Who approves a refund?",
  }),
  inputHash: "b".repeat(64),
  requestedAt: "2026-11-17T10:00:00.000Z",
  binding: null,
};

/**
 * The Inbox at `/inbox` for an admin, with the Brain's open `gaps` and the
 * person's `held` writes as what waits, in a window `width` wide.
 */
const shown = async (
  gaps: Gap[],
  width: number,
  at = "/inbox",
  held: PendingAction[] = [],
  /** The reads that failed, as the page's loader hands them over. */
  notLoaded: Loaded<unknown>[] = []
) => {
  windowOf(width);
  let open = gaps;
  let waitingWrites = held;
  const decided: string[] = [];
  const brain = {
    answerGap: async (gap: string) => {
      await Promise.resolve();
      open = open.filter(({ id }) => id !== gap);
      return {};
    },
  };
  const pendingActions = {
    confirm: async (id: string, hash: string) => {
      await Promise.resolve();
      decided.push(`confirm ${id} ${hash}`);
      waitingWrites = waitingWrites.filter((write) => write.id !== id);
    },
    decline: async (id: string) => {
      await Promise.resolve();
      decided.push(`decline ${id}`);
      waitingWrites = waitingWrites.filter((write) => write.id !== id);
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        brain: typeof brain;
        pendingActions: typeof pendingActions;
      }) => Promise<T>
    ): Promise<T> => await action({ brain, pendingActions }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const inbox = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
    validateSearch: z.object({ item: z.string().optional() }),
    loader: async (): Promise<{ gaps: Gap[]; held: PendingAction[] }> => {
      await Promise.resolve();
      return { gaps: open, held: waitingWrites };
    },
  });
  const Inbox = () => {
    const { gaps: waits, held: writes } = inbox.useLoaderData();
    const { item } = inbox.useSearch();
    const waiting = {
      held: { state: "ready", data: writes },
      outcomes: { state: "ready", data: [] },
      notifications: {
        state: "ready",
        data: { page: { notifications: [], unread: 0, more: false } },
      },
      reconnect: { state: "ready", data: [] },
      requests: undefined,
      decisions: { state: "ready", data: [] },
      workflowGoLives: { state: "ready", data: [] },
      heldStarts: { state: "ready", data: [] },
      bindings: { state: "ready", data: [] },
      gaps: { state: "ready", data: waits },
    } satisfies Waiting;
    return (
      <Frame>
        <InboxPage
          chosen={item}
          items={inboxItems(
            waiting,
            { role: "admin", staff: false, name: "Ada Admin" },
            "2026-11-17T12:00:00.000Z"
          )}
          notLoaded={notLoaded}
        />
      </Frame>
    );
  };
  inbox.update({ component: Inbox });
  const router = createRouter({
    routeTree: rootRoute.addChildren([inbox]),
    history: createMemoryHistory({ initialEntries: [at] }),
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
  return {
    /** The item in the address, as a link would carry it. */
    item: () => router.state.location.search.item,
    /** What core was told of each held write. */
    decided,
  };
};

/** Lets what a press or a key started settle. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const key = async (name: string) => {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true })
    );
    await Promise.resolve();
  });
  await settle();
};

/** Presses the row of the item that asks `question`. */
const pressRow = async (question: string) => {
  await act(async () => {
    [...document.querySelectorAll("a")]
      .find((each) => each.textContent.includes(question))
      ?.click();
    await Promise.resolve();
  });
  await settle();
};

const asked = /Who [^?]+\?/u;
const placed = /\d of \d/u;

/** The item a panel shows and where the walk stands; nothing while the panel is away. */
const walkIn = (
  panel: Element | null
): { question: string; place: string } | undefined => {
  const said = panel?.textContent;
  return said === undefined
    ? undefined
    : {
        question: asked.exec(said)?.[0] ?? "",
        place: placed.exec(said)?.[0] ?? "",
      };
};

/** What the shell's page panel shows, beside the page. */
const beside = () =>
  walkIn(document.querySelector("aside[aria-label='Brain question']"));

/** What the shell's sheet shows, on a phone. */
const sheet = () => walkIn(document.querySelector("[role='dialog']"));

describe("the inbox in the shell", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("says once why nothing loaded, however many reads failed for that reason", async () => {
    const offline: Loaded<unknown> = { state: "offline" };
    await shown([], 1440, "/inbox", [], [offline, offline, offline]);
    const said = "Grasp can't be reached right now. Try again in a moment.";
    expect(document.body.textContent?.split(said)).toHaveLength(2);
  });

  it("shows the first item in the shell's panel beside the list, and J and K walk what waits", async () => {
    const page = await shown(three(), 1440);
    const first = beside();
    await key("j");
    const next = { ...beside(), item: page.item() };
    await key("k");
    const back = { ...beside(), item: page.item() };

    expect({ first, next, back }).toStrictEqual({
      first: { question: "Who approves a refund?", place: "1 of 3" },
      next: {
        question: "Who pays the invoices?",
        place: "2 of 3",
        item: "gap:gap-2",
      },
      back: {
        question: "Who approves a refund?",
        place: "1 of 3",
        item: "gap:gap-1",
      },
    });
  });

  it("opens the one after an item once that item is settled", async () => {
    await shown(three(), 1440, "/inbox?item=gap:gap-2");
    const box = document.querySelector("textarea");
    await act(async () => {
      if (box !== null) {
        box.value = "The sales lead.";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((each) => each.textContent.trim() === "Answer")
        ?.click();
      await Promise.resolve();
    });
    await settle();

    expect(beside()).toStrictEqual({
      question: "Who signs a quote?",
      place: "2 of 2",
    });
    expect(document.querySelector("output")?.textContent).toBe(
      "Answered: Who pays the invoices?"
    );
  });

  it("shows a held email as its draft, and Send confirms exactly its input and the item leaves", async () => {
    const page = await shown(three(), 1440, "/inbox?item=held:write-1", [
      heldEmail,
    ]);
    const draft = document.querySelector(
      "section[aria-label='Email: Refunds']"
    );
    const atFirst = {
      draft: draft !== null,
      // A held draft is locked: its subject shows whole, as text.
      subject: draft?.textContent.includes("Refunds"),
    };
    await act(async () => {
      [...document.querySelectorAll("button")]
        // The press's words, then what it says while working, hidden till then.
        .find((each) => each.textContent.trim().startsWith("Send"))
        ?.click();
      await Promise.resolve();
    });
    await settle();

    expect({
      atFirst,
      decided: page.decided,
      left: document.querySelector("section[aria-label='Email: Refunds']"),
      said: document.querySelector("output")?.textContent,
    }).toStrictEqual({
      atFirst: { draft: true, subject: true },
      decided: [`confirm write-1 ${"b".repeat(64)}`],
      left: null,
      said: "Approved: Approve Send an email on Microsoft 365 (ada@acme.test)?",
    });
  });

  it("opens an item as the shell's sheet on a phone once its row is pressed, and closing it leaves the item", async () => {
    const page = await shown(three(), 390);
    const atFirst = { sheet: sheet(), beside: beside() };
    await pressRow("Who pays the invoices?");
    const opened = sheet();
    await key("Escape");

    expect({ atFirst, opened }).toStrictEqual({
      atFirst: { sheet: undefined, beside: undefined },
      opened: { question: "Who pays the invoices?", place: "2 of 3" },
    });
    expect({ sheet: sheet(), item: page.item() }).toStrictEqual({
      sheet: undefined,
      item: undefined,
    });
  });
});
