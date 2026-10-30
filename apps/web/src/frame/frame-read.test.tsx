// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { frameReadMs } from "../core-connection.ts";
import { useFrameRead } from "./frame-read.ts";

// What the frame reads beside every page (the sidebar's counts, the chat
// dock's models), in a router as the shell's: read once, not on every
// click, but again after a change on a page and once it is old. How it
// could go wrong, each tried below: a read on every click; a change on a
// page left out of the count; a count that never catches up with what
// others changed; a filter typed into reading it on every key.

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

/**
 * The frame at `/a`, with pages `/a` and `/b`, showing what it read: each
 * read answers its number, at once or, `held`, once let through; shown
 * on every page, or only on `shownOn`.
 */
const opened = async ({
  held = false,
  shownOn,
}: { held?: boolean; shownOn?: string } = {}) => {
  let reads = 0;
  const holding: (() => void)[] = [];
  const read = async (): Promise<number> => {
    reads += 1;
    const mine = reads;
    if (held) {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      holding.push(() => {
        resolve(true);
      });
      await promise;
    }
    return mine;
  };
  const Frame = () => {
    const { pathname } = useLocation();
    const { value, readAgain } = useFrameRead(
      read,
      shownOn === undefined || pathname === shownOn
    );
    return (
      <>
        <output>{value}</output>
        <button onClick={readAgain} type="button">
          Read again
        </button>
        <Outlet />
      </>
    );
  };
  const rootRoute = createRootRoute({ component: Frame });
  const routeTree = rootRoute.addChildren(
    ["/a", "/b"].map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        validateSearch: (search: Record<string, unknown>) => ({
          q: typeof search.q === "string" ? search.q : undefined,
        }),
        component: () => <p>{path}</p>,
      })
    )
  );
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/a"] }),
    // SAFETY: the read stands in for core and never touches it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    context: { core: {} as never },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<RouterProvider router={router} />);
    await router.load();
  });
  return {
    router,
    /** Goes to `href`, as a click on a link to it does. */
    go: async (href: string): Promise<void> => {
      act(() => {
        router.history.push(href);
      });
      await settled();
    },
    /** Lets read number `number` answer. */
    answer: async (number: number): Promise<void> => {
      holding[number - 1]?.();
      await settled();
    },
    readAgain: async (): Promise<void> => {
      act(() => {
        document.querySelector("button")?.click();
      });
      await settled();
    },
    reads: () => reads,
    shown: () => document.querySelector("output")?.textContent,
  };
};

describe("what the frame reads beside every page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("reads once, not again on the way between pages", async () => {
    const frame = await opened();
    await settled();

    for (const href of ["/b", "/a", "/b"]) {
      // oxlint-disable-next-line no-await-in-loop -- one click after the other
      await frame.go(href);
    }
    await settled();

    expect({ reads: frame.reads(), shown: frame.shown() }).toStrictEqual({
      reads: 1,
      shown: "1",
    });
  });

  it("reads again after a change on a page, and shows the new answer", async () => {
    const frame = await opened();
    await settled();

    await act(async () => {
      await frame.router.invalidate();
    });
    await settled();

    expect({ reads: frame.reads(), shown: frame.shown() }).toStrictEqual({
      reads: 2,
      shown: "2",
    });
  });

  it("reads again on the way to another page once what it read is old, not when only the search changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const frame = await opened();
    await settled();
    vi.setSystemTime(Date.now() + frameReadMs);

    await frame.go("/a?q=typed");
    await settled();
    const afterSearch = frame.reads();
    await frame.go("/b");
    await settled();

    expect({ afterSearch, reads: frame.reads() }).toStrictEqual({
      afterSearch: 1,
      reads: 2,
    });
  });

  it("keeps only the newest answer when read again before an older one came back", async () => {
    const frame = await opened({ held: true });
    await frame.readAgain();

    await frame.answer(2);
    await frame.answer(1);

    expect({ reads: frame.reads(), shown: frame.shown() }).toStrictEqual({
      reads: 2,
      shown: "2",
    });
  });

  it("reads nothing on a page that shows none, and reads once shown", async () => {
    const frame = await opened({ shownOn: "/b" });
    await settled();
    const hidden = frame.reads();

    await frame.go("/b");

    expect({
      hidden,
      reads: frame.reads(),
      shown: frame.shown(),
    }).toStrictEqual({ hidden: 0, reads: 1, shown: "1" });
  });
});
