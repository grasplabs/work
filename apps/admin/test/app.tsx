/**
 * The admin as the browser runs it, for the component tests
 * (vite.components.config.ts, the .test.tsx files under src): its real router, routes, loaders and
 * components, at an address, in happy-dom. Its server functions are
 * answered here, at the page's own boundary (`/_serverFn`, in Start's wire
 * format), as the Worker would answer them: what the Worker answers, and
 * who may call it, is tested in workerd (test/). Nothing of the app is
 * replaced.
 */

import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { fromJSON, toCrossJSONAsync } from "seroval";
import type { SerovalJSON } from "seroval";
import { afterEach, vi } from "vite-plus/test";

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

/** Server function calls the page made that aren't answered yet. */
let inFlight = 0;

/** The router of the admin opened last. */
let opened: { state: { status: string } } | undefined;

/** Unmounts the page opened last, its effects, subscriptions and timers with it. */
const unmountOpened = (): void => {
  act(() => {
    mounted?.unmount();
  });
  mounted = undefined;
};

afterEach(() => {
  unmountOpened();
  opened = undefined;
  inFlight = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** How long a page may take to come to rest before a test fails on it. */
const restMs = 5000;

/** One macrotask, past React's and the router's microtasks. */
const tick = async (): Promise<void> => {
  await act(async () => {
    // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form here
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  });
};

/**
 * Lets the page's reads, its routes' code and its renders run to rest:
 * until the router is idle with no server function call unanswered, a few
 * turns in a row.
 */
export const settle = async (): Promise<void> => {
  const until = Date.now() + restMs;
  let still = 0;
  while (still < 3) {
    if (Date.now() > until) {
      throw new Error("The page didn't come to rest");
    }
    // oxlint-disable-next-line no-await-in-loop -- each turn waits on what the last one started
    await tick();
    still = inFlight === 0 && opened?.state.status === "idle" ? still + 1 : 0;
  }
};

/** Waits until `shown` holds, as the page goes on: a page that never comes to rest. */
export const until = async (shown: () => boolean): Promise<void> => {
  const deadline = Date.now() + restMs;
  while (!shown()) {
    if (Date.now() > deadline) {
      throw new Error("The page never showed it");
    }
    // oxlint-disable-next-line no-await-in-loop -- each turn waits on what the last one started
    await tick();
  }
};

/**
 * The admin opened at `path`, its server functions answered from
 * `answers` over a frame with no organizations: what the page shows
 * (`main`, `text`), every call it made (`calls`), and its router.
 */
export const openAdmin = async (
  path: string,
  answers: Answers = {},
  /** Whether to wait for the page to come to rest: not while a read never answers. */
  { rest = true }: { rest?: boolean } = {}
) => {
  const calls: Call[] = [];
  const answered: Answers = {
    fetchClientGrid: [] satisfies GridRow[],
    fetchClientAdmins: [] satisfies ClientAdmin[],
    reportPageErrorFn: { logged: true },
    ...answers,
  };
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.href
      );
      const fn = fnOf(url);
      const data = dataOf(url, init);
      calls.push({ fn, data });
      inFlight += 1;
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
        inFlight -= 1;
      }
    }
  );
  // One page at a time: the one opened before stops before this one starts.
  unmountOpened();
  const router = getRouter();
  router.update({
    context: router.options.context,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  opened = router;
  // On the document, as Start's client entry mounts it: the root route
  // renders the document's own <html> and <body>. Mounted on an element
  // inside the body instead, the app's <body> would sit above the root it
  // renders from: once a dialog had portalled into the body (React
  // listens there from then on), an event bubbling to it walks from the
  // body up to that root and back to the body without end (react-dom's
  // dispatchEventForPluginEventSystem), and the test hangs.
  act(() => {
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
