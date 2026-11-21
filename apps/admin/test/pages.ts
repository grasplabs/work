import { SidebarProvider } from "@grasp-os/app-kit/components/sidebar";
import { TooltipProvider } from "@grasp-os/app-kit/components/tooltip";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from "@tanstack/react-router";
import type { AnyRoute } from "@tanstack/react-router";
import { exports } from "cloudflare:workers";
import { createElement } from "react";
import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { fromCrossJSON, toJSONAsync } from "seroval";
import { z } from "zod";

import { accessJwt } from "./access.ts";

const origin = "https://ops.grasp.test";

/** A page's scripts: not what it shows. */
const scripts = /<script\b[^>]*>[\s\S]*?<\/script>/gu;

/**
 * The document the Worker answers `path` with, as `email`'s browser gets
 * it: the admin's shell, which its scripts fill in the browser.
 */
export const documentOf = async (
  path: string,
  email = "staff@grasp.test"
): Promise<{ status: number; html: string }> => {
  const response = await exports.default.fetch(`${origin}${path}`, {
    headers: { "cf-access-jwt-assertion": await accessJwt(email) },
  });
  return { status: response.status, html: await response.text() };
};

/**
 * `element`'s markup once everything it waits on is in, rendered inside a
 * router of its own, as the page would show it: for a section whose words
 * come from rich records the Worker answers (an organization's Setup),
 * tested from those real answers rather than copies of them. The pages
 * themselves render in the browser (test/app.tsx).
 */
/** The admin's frame around a page: its sidebar's and tooltips' providers. */
const framed = (children: ReactElement): ReactElement =>
  createElement(
    TooltipProvider,
    null,
    createElement(SidebarProvider, null, children)
  );

export const rendered = async (element: ReactElement): Promise<string> => {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => framed(element) }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const { prelude } = await prerender(
    createElement(RouterProvider, { router })
  );
  const html = await new Response(prelude).text();
  return html.replaceAll(scripts, "");
};

/**
 * The page `route` (a route of the admin's, at `pattern`, as its file
 * names it) shows at `at` once its loader gave `loaderData`, rendered as `rendered` does: a page whose words come
 * from rich records the Worker answers (a release, the channels), tested
 * from those real answers. Its route reads them with the server functions
 * the test calls through the Worker's entry.
 */
export const renderedPage = async (
  route: AnyRoute,
  pattern: string,
  at: string,
  loaderData: unknown
): Promise<string> => {
  const root = createRootRoute({
    component: () => framed(createElement(Outlet)),
  });
  const pageRoute = createRoute({
    getParentRoute: () => root,
    path: pattern,
    component: route.options.component,
    loader: () => loaderData,
  });
  const router = createRouter({
    routeTree: root.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  await router.load();
  const { prelude } = await prerender(
    createElement(RouterProvider, { router })
  );
  const html = await new Response(prelude).text();
  return html.replaceAll(scripts, "");
};

/** What TanStack Start's route for server functions answers, deserialized. */
const answerSchema = z.object({
  result: z.unknown(),
  error: z.unknown().optional(),
});

/** Who a server function is called as, and from where. */
export interface Caller {
  /** The staff member Access vouches for; null for a request without its JWT. */
  email?: string | null;
  /** The page's origin, as the browser sends it: the admin's own unless given; null for none. */
  from?: string | null;
  /** What the browser says of where the call comes from (`Sec-Fetch-Site`); unsent unless given. */
  fetchSite?: string;
}

/**
 * What server function `fn` answers `data` with, called as the admin's
 * own pages call it: through the Worker's entry as `caller.email` (a staff
 * member), at TanStack Start's route for server functions, in its wire
 * format. A `caller` can also be what the admin's pages never are:
 * another site's page, or no one Access vouches for. An answer that isn't
 * one (a refusal) throws, saying its status. A GET function takes its data
 * in the query, as the pages' client sends it.
 */
export const callServerFn = async <Data, Result>(
  fn: ((options: { data: Data }) => Promise<Result>) & {
    serverFnMeta?: { id: string };
    method?: string;
  },
  // A function that takes no data is called without it.
  ...[
    data,
    { email = "staff@grasp.test", from = origin, fetchSite } = {},
  ]: undefined extends Data
    ? [data?: Data, caller?: Caller]
    : [data: Data, caller?: Caller]
): Promise<Result> => {
  const id = fn.serverFnMeta?.id;
  if (id === undefined) {
    throw new Error("Not a server function");
  }
  // Plain data needs none of the plugins the pages' client adds.
  const payload = JSON.stringify(await toJSONAsync({ data }));
  const get = fn.method === "GET";
  const url = `${origin}/_serverFn/${id}`;
  const response = await exports.default.fetch(
    get ? `${url}?${new URLSearchParams({ payload })}` : url,
    {
      method: get ? "GET" : "POST",
      headers: {
        ...(email === null
          ? {}
          : { "cf-access-jwt-assertion": await accessJwt(email) }),
        ...(from === null ? {} : { origin: from }),
        ...(fetchSite === undefined ? {} : { "sec-fetch-site": fetchSite }),
        "x-tsr-serverFn": "true",
        ...(get ? {} : { "content-type": "application/json" }),
        accept: "application/json",
      },
      body: get ? undefined : payload,
    }
  );
  if (!response.ok) {
    throw new Error(`The server function answered ${response.status}`);
  }
  // The entry answers `{ result }`, or `{ error }` for a function that threw.
  const answer = answerSchema.parse(
    fromCrossJSON(await response.json(), { refs: new Map() })
  );
  if (answer.error !== undefined) {
    throw new Error("The server function threw", { cause: answer.error });
  }
  // SAFETY: `result` is what `fn` returned, which is `Result`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return answer.result as Result;
};
