// @vitest-environment happy-dom
import type { ChatSummary } from "@grasp-os/shared/chat";
import { SidebarProvider, useSidebar } from "@grasp-os/ui/components/sidebar";
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
import { useRecentChats } from "./sidebar-chats.tsx";

// The sidebar's recent chats on a phone, where the sidebar is a sheet over
// the page: a chat is a link to its own page, which the frame's sheet
// closes for as it navigates; All chats navigates nowhere, so the sheet
// closes itself first, or it would stay over what opened and keep focus.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const chat: ChatSummary = {
  id: "chat-1",
  title: "Travel costs",
  agentId: "agent-1",
  createdAt: "2026-11-17T09:00:00.000Z",
  lastAt: "2026-11-17T09:00:00.000Z",
  running: false,
  make: null,
  archived: false,
};

/** The sidebar with the recent chats, and the phone's sheet: whether it is open, and a way to open it. */
const Frame = () => {
  const { openMobile, setOpenMobile } = useSidebar();
  const chats = useRecentChats({ enabled: true });
  return (
    <>
      <output>{openMobile ? "sheet open" : "sheet closed"}</output>
      <button
        onClick={() => {
          setOpenMobile(true);
        }}
        type="button"
      >
        Open the sheet
      </button>
      <FrameSidebar
        aria-label="Sidebar"
        closeLabel="Close"
        foldLabel="Show or hide the sidebar"
        groups={[{ id: "chats", rows: chats.rows, more: chats.more }]}
        mark={null}
        navLabel="Main"
        profile={null}
      />
    </>
  );
};

const shown = async () => {
  const session = {
    chats: { list: async () => await Promise.resolve([chat]) },
  };
  const core = {
    withSession: async <T,>(
      read: (reached: typeof session) => Promise<T>
    ): Promise<T> => await read(session),
  };
  const rootRoute = createRootRoute({ component: Frame });
  const router: AnyRouter = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/" }),
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
};

const sheet = (): string => document.querySelector("output")?.textContent ?? "";

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No button "${name}"`);
  }
  return found;
};

const press = (name: string) => {
  act(() => {
    button(name).click();
  });
};

describe("the sidebar's recent chats on a phone", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("links each chat to its own page, which the frame's sheet closes for", async () => {
    await shown();
    await vi.waitFor(() => {
      expect(
        [...document.querySelectorAll("a")].find(
          (each) => each.textContent.trim() === chat.title
        )
      ).toBeDefined();
    });
    const link = [...document.querySelectorAll("a")].find(
      (each) => each.textContent.trim() === chat.title
    );
    expect(link?.getAttribute("href")).toBe(`/chats/${chat.id}`);
  });

  it("closes the sheet when All chats opens from it", async () => {
    await shown();
    await vi.waitFor(() => {
      expect(button("All chats")).toBeDefined();
    });
    press("Open the sheet");
    expect(sheet()).toBe("sheet open");
    press("All chats");
    expect(sheet()).toBe("sheet closed");
  });
});
