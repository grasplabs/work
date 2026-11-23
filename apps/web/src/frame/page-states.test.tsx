import type { CoreApi } from "@grasp-os/shared/rpc";
// @vitest-environment happy-dom
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import type { AnyRoute } from "@tanstack/react-router";
import type { RpcStub } from "capnweb";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { WorkKnowledgeTab } from "../brain/work-knowledge.tsx";
import { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { InFrame } from "./in-frame.ts";
import {
  ErrorState,
  NotFound,
  NotFoundState,
  PageError,
  PageNotLoaded,
} from "./page-states.tsx";

// The pages that stand where a page can't, as the router shows them: an
// address no page has says so and leads to Chat, and a page that didn't
// load says why, reads the page again on Try again, and leads to Chat too.
// Only where the state is the whole page in the frame: a section's own
// error leaves the page around it, and outside the frame nobody may be
// signed in to go to Chat.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const reason = "Grasp can't be reached right now. Reference: req-1";

/** The app at `path`, in the frame or not, counting the broken page's reads. */
const opened = async (path: string, inFrame = true) => {
  const reads = { broken: 0 };
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <p>Chat</p>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/broken",
      loader: () => {
        reads.broken += 1;
      },
      component: () => <PageError reason={reason} />,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/section",
      component: () => (
        <>
          <ErrorState heading="h2" reason={reason} />
          <NotFoundState heading="h2" title="Note not found" />
        </>
      ),
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultNotFoundComponent: () => <NotFound />,
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <SidebarProvider>
          <InFrame value={inFrame}>
            <RouterProvider router={router} />
          </InFrame>
        </SidebarProvider>
      </I18nProvider>
    );
    await router.load();
  });
  return { router, reads };
};

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

/** The link or button whose text is `name`, if there is one. */
const control = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("a, button")].find(
    (element) => element.textContent?.trim() === name
  );

/** Clicks the control named `name`, then lets it settle. */
const click = async (name: string): Promise<void> => {
  const found = control(name);
  if (found === undefined) {
    throw new Error(`No control named ${name}`);
  }
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

const heading = (): string | undefined =>
  document.querySelector("h1")?.textContent ?? undefined;

describe("where a page can't stand", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  describe("the not-found page", () => {
    it("says the page isn't here and why, and goes to Chat", async () => {
      const { router } = await opened("/no-such-page");
      expect(heading()).toBe("This page is not here");
      expect(document.body.textContent).toContain(
        "The address may be wrong, or the page was moved or removed."
      );

      await click("Go to Chat");
      expect(router.state.location.pathname).toBe("/");
      expect(document.body.textContent).toContain("Chat");
      expect(heading()).toBeUndefined();
    });

    it("offers no way to Chat outside the frame", async () => {
      await opened("/no-such-page", false);
      expect(heading()).toBe("This page is not here");
      expect(control("Go to Chat")).toBeUndefined();
    });
  });

  describe("the error page", () => {
    it("says why with the request ID, and reads the page again on Try again", async () => {
      const { router, reads } = await opened("/broken");
      expect(heading()).toBe("This page didn't load");
      expect(document.body.textContent).toContain(reason);
      expect(reads.broken).toBe(1);

      await click("Try again");
      expect(reads.broken).toBe(2);
      expect(router.state.location.pathname).toBe("/broken");
    });

    it("goes to Chat", async () => {
      const { router } = await opened("/broken");
      await click("Go to Chat");
      expect(router.state.location.pathname).toBe("/");
    });
  });

  describe("a section's own states", () => {
    it("keep Try again but leave the way on to the page around them", async () => {
      await opened("/section");
      expect(control("Try again")).toBeDefined();
      expect(control("Go to Chat")).toBeUndefined();
    });
  });
});

// A page whose read found Grasp out of reach, as after a blip: it reads
// again by itself once a connection to core answers, and says it can't be
// reached only while none does. Core stands in as the tab's connections,
// each scripted: the first drops under the page's read, as a socket does,
// and the next ones answer, or fail, as the test says. The page coming
// back online cuts the pause before each attempt short, so the test, not
// a clock, says when the tab tries again.

/** How each connection after the first does: answers, or fails as core down does. */
type Attempt = "answers" | "down";

/**
 * A tab on a stand-in core, its connections after the first doing as
 * `attempts` says. On the first, every read drops the connection, or, given
 * `refusal`, is refused with that code, core's answer.
 */
const tabOnCore = (attempts: Attempt[], refusal?: string) => {
  const breaks: (() => void)[] = [];
  const reads = { apps: 0, work: 0 };
  let connections = 0;
  let back: (() => void) | undefined;
  const core = new CoreConnection({
    onSessionEnded: () => {
      // Nobody signs out here.
    },
    watchPage: (onBack) => {
      back = onBack;
    },
    connect: () => {
      connections += 1;
      const connection = connections;
      const attempt = connection === 1 ? "answers" : attempts[connection - 2];
      /** `answer`, unless this is the first connection. */
      const read = async <T,>(answer: T): Promise<T> => {
        await Promise.resolve();
        if (connection === 1 && refusal !== undefined) {
          throw Object.assign(new Error("Refused."), { code: refusal });
        }
        if (connection === 1) {
          // The socket drops: what was on its way fails without a code.
          breaks[0]?.();
          throw new Error("Peer closed WebSocket: 1006");
        }
        return answer;
      };
      const session = {
        whoami: async () => await Promise.resolve({ userId: "ada" }),
        apps: {
          list: async () => {
            reads.apps += 1;
            return await read([{ name: "Invoices" }]);
          },
        },
        brain: {
          work: async (id: string) => {
            reads.work += 1;
            return await read({
              id,
              name: "Invoicing",
              sentences: [],
              confidence: "heard",
              canAskMore: false,
              moreAsked: false,
            });
          },
        },
      };
      const stub = {
        authenticate: async () => {
          await Promise.resolve();
          if (attempt !== "answers") {
            throw new Error("The socket closed.");
          }
          return session;
        },
        onRpcBroken: (onBroken: () => void) => {
          breaks.push(onBroken);
        },
        [Symbol.dispose]: () => {
          // Nothing to let go of.
        },
      };
      // SAFETY: the tab reaches only `authenticate`, `whoami`,
      // `apps.list`, `brain.work`, `onRpcBroken` and disposal, which this
      // stand-in has.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
      return stub as unknown as RpcStub<CoreApi>;
    },
  });
  /** The page comes back online: the tab tries at once, then settles. */
  const online = async (): Promise<void> => {
    await act(async () => {
      back?.();
      await Promise.resolve();
    });
    await settled();
    await settled();
  };
  /** The first connection drops, with nothing on its way. */
  const drop = (): void => {
    breaks[0]?.();
  };
  return { core, reads, online, drop, connections: () => connections };
};

/** Whether `data`, a route's loader data, is what the Apps page read. */
const isRead = (data: unknown): data is Loaded<{ name: string }[]> =>
  typeof data === "object" && data !== null && "state" in data;

/** `routeTree` over `core`, rendered in the frame. */
const render = async (core: CoreConnection, routeTree: AnyRoute) => {
  const router = createRouter({
    routeTree,
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
          <InFrame value>
            <RouterProvider router={router} />
          </InFrame>
        </SidebarProvider>
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
};

/** A page that reads for itself: a piece of work's Knowledge tab. */
const workPage = async (core: CoreConnection) => {
  const rootRoute = createRootRoute({ component: Outlet });
  await render(
    core,
    rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => <WorkKnowledgeTab work="invoicing" />,
      }),
    ])
  );
};

/** The page listing Ada's Apps, read over `core`, shown with what it read. */
const appsPage = async (core: CoreConnection) => {
  const rootRoute = createRootRoute({ component: Outlet });
  const Apps = () => {
    const page: unknown = useRouterState({
      select: ({ matches }) => matches.at(-1)?.loaderData,
    });
    if (!isRead(page)) {
      return null;
    }
    return page.state === "ready" ? (
      <h1>{page.data.map(({ name }) => name).join(",")}</h1>
    ) : (
      <PageNotLoaded crumbs={[{ label: "Apps" }]} page={page} />
    );
  };
  await render(
    core,
    rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        loader: async () =>
          await loadFromCore(
            core,
            async (session) => await session.apps.list()
          ),
        component: Apps,
      }),
    ])
  );
};

describe("a page that found Grasp out of reach", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("reads again by itself once Grasp answers, and says it can't be reached only until then", async () => {
    const { core, reads, online } = tabOnCore(["down", "answers"]);
    await appsPage(core);
    const dropped = { heading: heading(), reads: reads.apps };
    // The next connection fails: still out of reach, and nothing is read.
    await online();
    const stillDown = { heading: heading(), reads: reads.apps };
    // The one after answers: the page reads again, without Try again.
    await online();
    expect({
      dropped,
      stillDown,
      back: { heading: heading(), reads: reads.apps },
    }).toStrictEqual({
      dropped: { heading: "This page didn't load", reads: 1 },
      stillDown: { heading: "This page didn't load", reads: 1 },
      back: { heading: "Invoices", reads: 2 },
    });
  });

  it("reads a part it reads itself again too, once Grasp answers, rather than the page", async () => {
    const { core, reads, online } = tabOnCore(["answers"]);
    await workPage(core);
    const dropped = {
      unreachable: document.body.textContent?.includes("can't be reached"),
      reads: reads.work,
    };
    await online();
    expect({
      dropped,
      back: {
        shown: document.body.textContent?.includes(
          "Grasp knows nothing about this work in its own words yet."
        ),
        reads: reads.work,
      },
    }).toStrictEqual({
      dropped: { unreachable: true, reads: 1 },
      back: { shown: true, reads: 2 },
    });
  });

  it.each([
    ["refused", "role.forbidden"],
    ["not found", "app.not_found"],
  ])(
    "never reads a page core answered %s again as its connection comes back",
    async (_answer, code) => {
      const { core, reads, online, drop, connections } = tabOnCore(
        ["answers"],
        code
      );
      await appsPage(core);
      drop();
      await online();
      expect({ connections: connections(), reads: reads.apps }).toStrictEqual({
        connections: 2,
        reads: 1,
      });
    }
  );
});
