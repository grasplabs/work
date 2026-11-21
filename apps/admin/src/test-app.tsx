/**
 * The admin as the browser runs it, for the component tests
 * (vite.components.config.ts): its real router, routes, loaders and
 * components, at an address, in happy-dom. Its server functions are
 * answered here, at the page's own boundary (`/_serverFn`, in Start's wire
 * format), as the Worker would answer them: what the Worker answers, and
 * who may call it, is tested in workerd (test/). Nothing of the app is
 * replaced.
 */
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { fromJSON, toCrossJSONAsync } from "seroval";
import type { SerovalJSON } from "seroval";
import { afterEach, vi } from "vite-plus/test";

import type { ClientAdmin } from "./clients/admin.ts";
import type { GridRow } from "./clients/grid.ts";
import { getRouter } from "./router.tsx";

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

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Lets the page's reads and renders run to rest. */
export const settle = async (rounds = 5): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each round waits on what the last one started
    await act(async () => {
      // oxlint-disable-next-line promise/avoid-new -- a macrotask, past React's and the router's microtasks
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
};

/**
 * The admin opened at `path`, its server functions answered from
 * `answers` over a frame with no organizations: what the page shows
 * (`main`, `text`), every call it made (`calls`), and its router.
 */
export const openAdmin = async (path: string, answers: Answers = {}) => {
  const calls: Call[] = [];
  const answered: Answers = {
    fetchClientGrid: [] satisfies GridRow[],
    fetchClientAdmins: [] satisfies ClientAdmin[],
    reportPageErrorFn: undefined,
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
      if (!Object.hasOwn(answered, fn)) {
        throw new Error(`The page called ${fn}, which the test doesn't answer`);
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
    }
  );
  const router = getRouter();
  router.update({
    context: router.options.context,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  act(() => {
    mounted = createRoot(container);
    mounted.render(<RouterProvider router={router} />);
  });
  await settle();
  const main = (): string => container.querySelector("main")?.textContent ?? "";
  return {
    calls,
    router,
    container,
    /** The page's main part, as text. */
    main,
    /** The whole page, as text. */
    text: (): string => container.textContent ?? "",
  };
};
