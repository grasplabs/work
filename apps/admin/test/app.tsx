/**
 * The admin as the browser runs it, for the component tests
 * (vite.components.config.ts, the .test.tsx files under src): its real router, routes, loaders and
 * components, at an address, in happy-dom. Its server functions are
 * answered here, at the page's own boundary (`/_serverFn`, in Start's wire
 * format), as the Worker would answer them: what the Worker answers, and
 * who may call it, is tested in workerd (test/). Nothing of the app is
 * replaced.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import type { AnyRoute } from "@tanstack/react-router";
import { act as reactAct } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { fromJSON, toCrossJSONAsync } from "seroval";
import type { SerovalJSON } from "seroval";
import { aroundEach, vi } from "vite-plus/test";

import type { AnsweredAdmin } from "../src/admin/org-reads.ts";
import type { ClientAdmin } from "../src/clients/admin.ts";
import type { GridRow } from "../src/clients/grid.ts";
import { getRouter } from "../src/router.tsx";
import { emptyAdminSnapshot } from "./snapshots.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A server function's call as the page made it: its name, and what it sent. */
export interface Call {
  fn: string;
  data: unknown;
}

/**
 * What each server function answers, by its name: a value, or a function
 * of what the page sent. One that throws answers as the Worker does when
 * a function fails. A function the page calls that isn't here fails the
 * test, so each test says everything its page reads.
 */
export type Answers = Record<string, unknown>;

/** Whether `answer` is a function of what the page sent, rather than a value. */
const isAnswerFn = (answer: unknown): answer is (data: unknown) => unknown =>
  typeof answer === "function";

/** Thrown by an answer to make its function fail, as the Worker's 500. */
export class FailedError extends Error {
  constructor() {
    super("Failed, as the test asked");
    this.name = "FailedError";
  }
}

/** A client as the grid has it: active, live, on Stable, nothing waiting. */
export const gridRow = (overrides: Partial<GridRow> = {}): GridRow => ({
  id: "acme",
  name: "Acme",
  status: "active",
  channel: "stable",
  hostname: "acme.grasp.test",
  release: null,
  pinnedReleaseId: null,
  lastDeploy: null,
  setup: null,
  rollout: { failed: null, behind: 0, channelStopped: null },
  ...overrides,
});

/**
 * A client whose core answered just now, as `fetchClientAdmin` answers
 * it: an empty snapshot, and neither Stripe nor Attio linked, unless given.
 */
export const answeredAdmin = (
  overrides: Partial<Omit<AnsweredAdmin, "state">> = {}
): AnsweredAdmin => {
  const client = overrides.client ?? gridRow();
  return {
    client,
    state: "answered",
    snapshot: emptyAdminSnapshot(client.name),
    at: new Date().toISOString(),
    billing: { state: "not_linked" },
    crm: { state: "not_linked" },
    ...overrides,
  };
};

/** The text of the line under `label` in a list of terms, or undefined. */
export const lineOf = (root: Element, label: string): string | undefined =>
  [...root.querySelectorAll("dt")].find((term) => term.textContent === label)
    ?.nextElementSibling?.textContent ?? undefined;

/** The server function a call at `url` is: its export's name, as Start names it. */
const fnOf = (url: URL): string => {
  const id = url.pathname.split("/")[2] ?? "";
  const named: unknown = JSON.parse(
    atob(id.replaceAll("-", "+").replaceAll("_", "/"))
  );
  const name: unknown =
    typeof named === "object" && named !== null
      ? Reflect.get(named, "export")
      : undefined;
  return typeof name === "string"
    ? name.replace(/_createServerFn_handler$/u, "")
    : id;
};

/** What the page sent `fn`: its `data`, from the query (GET) or the body. */
const dataOf = (url: URL, init: RequestInit | undefined): unknown => {
  const raw =
    url.searchParams.get("payload") ??
    (typeof init?.body === "string" ? init.body : null);
  if (raw === null) {
    return undefined;
  }
  // SAFETY: the page sends what seroval's `toJSONAsync` made: its JSON.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const sent: unknown = fromJSON(JSON.parse(raw) as SerovalJSON);
  return typeof sent === "object" && sent !== null
    ? Reflect.get(sent, "data")
    : undefined;
};

let mounted: Root | undefined;

/** An admin opened: its router, and the server function calls it made that aren't answered yet. */
interface Opened {
  router: { state: { status: string } };
  inFlight: number;
}

/**
 * A test's hold on the admin: the page it opened, its `act` scopes still
 * open, and whether it has ended. A test that timed out ends while its
 * body still runs; what that body calls here from then on refuses.
 */
interface Run {
  page: Opened | undefined;
  scopes: Set<Promise<void>>;
  ended: boolean;
  /** When a page that hasn't come to rest fails the test: just before its own timeout. */
  restBy: number;
  /** Settles when the test ends: an `act` scope it left open closes then. */
  ending: PromiseWithResolvers<void>;
}

/**
 * How long before its test's own timeout a page still not at rest fails
 * it, saying so: the runner's timeout would say only that time ran out.
 * A test given longer (`{ timeout }`) gives its pages longer too.
 */
const restMarginMs = 250;

/** The real clock, which a test's fake one (`vi.useFakeTimers`) leaves alone. */
const realNow = Date.now;

/** The run of the test whose code is calling: carried along its awaits, timers and calls. */
const runs = new AsyncLocalStorage<Run>();

/** What a test's code that goes on once the test has ended is told. */
const ended = (): Error =>
  new Error("This test has ended (it timed out): it acts on no page any more");

/** The calling test's run, while that test goes on. */
const own = (): Run => {
  const run = runs.getStore();
  if (run === undefined) {
    throw new Error("The admin's pages open only inside a test");
  }
  if (run.ended) {
    throw ended();
  }
  return run;
};

/** The page the calling test opened. */
const ownPage = (): Opened => {
  const { page } = own();
  if (page === undefined) {
    throw new Error("This test has opened no page");
  }
  return page;
};

/** Unmounts the page opened last, its effects, subscriptions and timers with it. */
const unmountOpened = (): void => {
  reactAct(() => {
    mounted?.unmount();
  });
  mounted = undefined;
};

// Each test runs as its own run, and what it left is cleared once it ends,
// a test that timed out too: the runner moves on while its body still
// runs, maybe inside an `act` scope. That scope closes first: one still
// open while the next test renders takes those renders into its own
// queue, and that test's pages show nothing. The body's next call here
// then throws, so it renders into, waits on or acts on no page of the
// next test's. And a clock it faked goes back to the real one, as its own
// `finally` would run only once its body ends.
aroundEach(async (runTest, { task }) => {
  const run: Run = {
    page: undefined,
    scopes: new Set(),
    ended: false,
    restBy: realNow() + task.timeout - restMarginMs,
    ending: Promise.withResolvers(),
  };
  try {
    await runs.run(run, runTest);
  } finally {
    run.ended = true;
    run.ending.resolve();
    await Promise.allSettled(run.scopes);
    unmountOpened();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

/**
 * React's `act` on the calling test's page: `move`, then what it set off
 * rendered. Refuses once the test has ended, and throws if it ended
 * meanwhile; its scope closes when the test ends, `move` still going on
 * outside it.
 */
export const act = async (move: () => unknown): Promise<void> => {
  const run = own();
  // A promise of its own: `act`'s thenable closes its scope on each `then`,
  // so it is awaited once, here.
  const scope = (async () => {
    await reactAct(async () => {
      await Promise.race([move(), run.ending.promise]);
    });
  })();
  run.scopes.add(scope);
  try {
    await scope;
  } finally {
    run.scopes.delete(scope);
  }
  own();
};

/** One macrotask on the calling test's page, past React's and the router's microtasks. */
const tick = async (): Promise<void> => {
  await act(async () => {
    // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form here
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  });
};

/**
 * Lets the calling test's page run its reads, its routes' code and its
 * renders to rest: until its router is idle with no server function call
 * unanswered, a few turns in a row.
 */
export const settle = async (): Promise<void> => {
  const page = ownPage();
  const { restBy } = own();
  let still = 0;
  while (still < 3) {
    if (realNow() > restBy) {
      throw new Error("The page didn't come to rest");
    }
    // oxlint-disable-next-line no-await-in-loop -- each turn waits on what the last one started
    await tick();
    still =
      page.inFlight === 0 && page.router.state.status === "idle"
        ? still + 1
        : 0;
  }
};

/** Waits until `shown` holds, as the calling test's page goes on: a page that never comes to rest. */
export const until = async (shown: () => boolean): Promise<void> => {
  ownPage();
  const { restBy } = own();
  while (!shown()) {
    if (realNow() > restBy) {
      throw new Error("The page never showed it");
    }
    // oxlint-disable-next-line no-await-in-loop -- each turn waits on what the last one started
    await tick();
  }
};

/**
 * The admin opened at `path`, its server functions answered from
 * `answers` over a frame with no organizations: what the page shows
 * (`main`, `text`), every call it made (`calls`), and its router. The
 * page is the calling test's, until it opens another.
 */
export const openAdmin = async (
  path: string,
  answers: Answers = {},
  /** Whether to wait for the page to come to rest: not while a read never answers. */
  { rest = true }: { rest?: boolean } = {}
) => {
  const run = own();
  const calls: Call[] = [];
  const answered: Answers = {
    fetchClientGrid: [] satisfies GridRow[],
    fetchClientAdmins: [] satisfies ClientAdmin[],
    fetchStaff: { name: "Sam Staff" },
    fetchReadiness: { checks: [], blocking: 0 },
    reportPageErrorFn: { logged: true },
    ...answers,
  };
  const router = getRouter();
  const page: Opened = { router, inFlight: 0 };
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // A call made on by a test that has ended is no call of this one's.
      if (runs.getStore()?.ended === true) {
        throw ended();
      }
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.href
      );
      const fn = fnOf(url);
      const data = dataOf(url, init);
      calls.push({ fn, data });
      page.inFlight += 1;
      try {
        if (!Object.hasOwn(answered, fn)) {
          throw new Error(
            `The page called ${fn}, which the test doesn't answer`
          );
        }
        const answer = answered[fn];
        let result: unknown;
        try {
          result = isAnswerFn(answer) ? await answer(data) : answer;
        } catch (error) {
          if (error instanceof FailedError) {
            return new Response("Internal Server Error", { status: 500 });
          }
          throw error;
        }
        return Response.json(
          await toCrossJSONAsync({ result }, { refs: new Map() }),
          { headers: { "x-tss-serialized": "true" } }
        );
      } finally {
        page.inFlight -= 1;
      }
    }
  );
  // One page at a time: the one opened before stops before this one starts.
  unmountOpened();
  router.update({
    context: router.options.context,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  run.page = page;
  // On the document, as Start's client entry mounts it: the root route
  // renders the document's own <html> and <body>. Mounted on an element
  // inside the body instead, the app's <body> would sit above the root it
  // renders from: once a dialog had portalled into the body (React
  // listens there from then on), an event bubbling to it walks from the
  // body up to that root and back to the body without end (react-dom's
  // dispatchEventForPluginEventSystem), and the test hangs.
  reactAct(() => {
    mounted = createRoot(document);
    mounted.render(<RouterProvider router={router} />);
  });
  await (rest ? settle() : tick());
  const container = document.body;
  const main = (): string => container.querySelector("main")?.textContent ?? "";
  return {
    calls,
    router,
    container,
    /** The page's main part, as text. */
    main,
    /** The whole page, as text. */
    text: (): string => container.textContent ?? "",
    /** The whole page's markup. */
    html: (): string => container.innerHTML,
  };
};

/**
 * Loads the code of the admin's routes under `under` (a route's id, such
 * as `/organizations/$clientId`), as the router does the first time a
 * page shows one: each route's component, error and not-found pages are
 * split into modules of their own. For a file whose tests open many of
 * them, so that each test times opening its pages, not loading and
 * transforming their code the first time.
 */
export const loadPages = async (under: string): Promise<void> => {
  const router = getRouter();
  // SAFETY: `routesById` holds the tree's routes by their ids; its values
  // come out as `any` here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const routes = Object.entries(router.routesById) as [string, AnyRoute][];
  await Promise.all(
    routes
      .filter(([id]) => id.startsWith(under))
      .map(async ([, route]) => {
        await router.loadRouteChunk(route);
        await router.loadRouteChunk(route, "errorComponent");
        await router.loadRouteChunk(route, "notFoundComponent");
      })
  );
};

/** What an organization's sections read beside its snapshot, while nothing more is set. */
export const sectionReads: Answers = {
  fetchClientSetup: null,
  fetchPinChoices: { releases: [] },
  fetchClientHosting: null,
  fetchProvisioningProgress: null,
  fetchClientAiStatus: null,
  fetchOrganizationTrail: [],
  fetchBrainReport: null,
};

/**
 * Companies whose cores answered: `add` one with its snapshot (its path
 * under organizations is what it answers), and `open` a page of the
 * admin with every one of them in the frame, `more` answered besides.
 */
export const companies = () => {
  const known = new Map<string, AnsweredAdmin>();
  return {
    add: (snapshot: AdminSnapshot): string => {
      const id = `client-${known.size + 1}`;
      known.set(
        id,
        answeredAdmin({
          client: gridRow({
            id,
            name: `Acme ${id}`,
            hostname: `${id}.grasp.test`,
          }),
          snapshot,
        })
      );
      return `/organizations/${id}`;
    },
    open: async (path: string, more: Answers = {}) =>
      await openAdmin(path, {
        fetchClientGrid: [...known.values()].map(({ client }) => client),
        fetchClientAdmin: (data: unknown) => {
          const clientId: unknown =
            typeof data === "object" && data !== null
              ? Reflect.get(data, "clientId")
              : undefined;
          return typeof clientId === "string"
            ? (known.get(clientId) ?? null)
            : null;
        },
        ...sectionReads,
        ...more,
      }),
  };
};
