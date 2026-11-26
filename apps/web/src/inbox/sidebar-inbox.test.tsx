// @vitest-environment happy-dom
import type { PendingAction } from "@grasp-os/shared/connect";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WaitingFeed } from "@grasp-os/shared/waiting";
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { FrameSidebar } from "../frame/sidebar.tsx";
import { useInboxGroups, useWaitingItems } from "./sidebar-inbox.tsx";

// The sidebar's Inbox view against core's feed of what waits, faked as the
// page reaches it over RPC, in the product's sidebar: All, to the inbox,
// then what waited longest, each to
// its place in the inbox, a quiet sentence when nothing waits; and
// listing them marks no notification read, as only the inbox does, and
// counts no notification already read.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const app = appIdSchema.parse("app-invoices");
const at = "2026-11-17T09:00:00.000Z";

const identity: Identity = {
  userId: "user-1",
  email: "user-1@acme.test",
  name: "Anna",
  role: "builder",
  teams: [],
  staff: false,
  expiresAt: "2026-12-01T09:00:00.000Z",
};

const action: PendingAction = {
  id: "write-1",
  subject: { type: "app", appId: app },
  appVersion: 3,
  mode: "interactive",
  context: { type: "app", appId: app },
  restricted: false,
  permissionId: "permission-1",
  connectionId: "connection-1",
  connectionName: "Microsoft 365",
  resource: null,
  action: "send_mail",
  description: { title: "Send an email", fields: [], complete: true },
  idempotencyKey: "key-1",
  input: "{}",
  inputHash: "0".repeat(64),
  requestedAt: at,
  binding: null,
};

const feedOf = (items: WaitingFeed["items"]): WaitingFeed => ({
  readAt: at,
  items,
  unread: [],
  unreadNotifications: items.filter((item) => item.kind === "openQuestion")
    .length,
});

const heldWrite: WaitingFeed["items"][number] = {
  kind: "heldWrite",
  id: "heldWrite:write-1",
  at,
  urgent: true,
  waitsOn: { type: "person", userId: "user-1" },
  verdicts: ["approve", "decline"],
  action,
};

const question: WaitingFeed["items"][number] = {
  kind: "openQuestion",
  id: "openQuestion:note-1",
  at,
  urgent: false,
  waitsOn: { type: "person", userId: "user-1" },
  verdicts: [],
  notification: {
    id: "note-1",
    type: "gap_asked",
    gap: "gap-1",
    question: "Who signs off on travel?",
    owner: "Finance",
    at,
    read: false,
  },
};

const admin: Identity = { ...identity, role: "admin" };

const shown = async (feed: WaitingFeed, who: Identity = identity) => {
  const markRead = vi.fn<(ids: string[], upTo: string) => Promise<void>>(
    async () => {
      await Promise.resolve();
    }
  );
  const listAll = vi.fn<() => Promise<unknown>>(async () => {
    await Promise.resolve();
  });
  const session = {
    waiting: { list: async () => await Promise.resolve(feed) },
    notifications: { markRead },
    unknownOutcomes: { listAll },
  };
  const core = {
    withSession: async <T,>(
      read: (reached: typeof session) => Promise<T>
    ): Promise<T> => await read(session),
  };
  const Frame = () => {
    const items = useWaitingItems(who, true);
    return (
      <>
        <output>{items?.length}</output>
        <FrameSidebar
          aria-label="Sidebar"
          closeLabel="Close"
          empty="Nothing waits for you."
          foldLabel="Show or hide the sidebar"
          groups={useInboxGroups(items)}
          mark={null}
          navLabel="Inbox"
          profile={null}
        />
      </>
    );
  };
  const rootRoute = createRootRoute({ component: Frame });
  const router: AnyRouter = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/inbox" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </I18nProvider>
    );
    await router.load();
  });
  return { markRead, listAll };
};

/** Each row's link and its name, without its second line. */
const rows = (): { href: string; name: string }[] =>
  [...document.querySelectorAll<HTMLAnchorElement>("nav a")].map((link) => ({
    href: link.getAttribute("href") ?? "",
    name: link.querySelector("span span")?.textContent ?? link.textContent,
  }));

const counted = (): string =>
  document.querySelector("output")?.textContent ?? "";

describe("the sidebar's inbox", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("leads to the inbox, counted, then to what has waited longest", async () => {
    await shown(feedOf([heldWrite, question]));
    await vi.waitFor(() => {
      expect(counted()).toBe("2");
    });
    const links = rows().map(({ href }) => href);
    // All, the inbox.
    expect(links.slice(0, 1)).toStrictEqual(["/inbox"]);
    // Then each item, to its place in the inbox.
    expect(links.slice(1).toSorted()).toStrictEqual([
      "/inbox?item=asked%3Anote-1",
      "/inbox?item=held%3Awrite-1",
    ]);
    expect(document.body.textContent).toContain("Waiting longest");
  });

  it("marks no notification read by listing it", async () => {
    const { markRead } = await shown(feedOf([question]));
    await vi.waitFor(() => {
      expect(counted()).toBe("1");
    });
    expect(markRead).not.toHaveBeenCalled();
  });

  it("counts no notification the person already read", async () => {
    // SAFETY: the question above, its notification marked read: the same kind.
    const read = {
      ...question,
      id: "openQuestion:note-2",
      notification: { ...question.notification, id: "note-2", read: true },
    } as WaitingFeed["items"][number];
    const { listAll } = await shown(feedOf([heldWrite, question, read]), admin);
    await vi.waitFor(() => {
      expect(counted()).toBe("2");
    });
    // Everyone's unknown outcomes are the inbox page's alone: core audits
    // each read of them, and the sidebar reads every few minutes.
    expect(listAll).not.toHaveBeenCalled();
  });

  it("says so quietly when nothing waits", async () => {
    await shown(feedOf([]));
    await vi.waitFor(() => {
      expect(counted()).toBe("0");
    });
    expect(rows()).toHaveLength(0);
    expect(document.body.textContent).toContain("Nothing waits for you.");
  });
});
