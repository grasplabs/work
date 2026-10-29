import { exports } from "cloudflare:workers";
import { fromCrossJSON, toJSONAsync } from "seroval";
import { z } from "zod";

import { accessJwt } from "./access.ts";

const origin = "https://ops.grasp.test";

const scripts = /<script\b[^>]*>[\s\S]*?<\/script>/gu;

/** A part of a page streamed in after the rest, and the placeholder it replaces: React's `$RC("B:n","S:n")`. */
const streamedPart = /\$RC\("(?<boundary>B:[^"]+)","(?<segment>S:[^"]+)"\)/u;
/** Where a streamed placeholder opens or closes: React's Suspense boundary comments. */
const boundaryMarks = /<!--\$[?!]?-->|<!--\/\$-->/gu;

/**
 * `html` as the browser ends up showing it: each part a page streamed in
 * after the rest (a read it didn't wait for) put in place of what held
 * its place, as React's own script does once it arrives.
 */
const settled = (html: string): string => {
  let page = html;
  let part = streamedPart.exec(page);
  while (part !== null) {
    const { boundary = "", segment = "" } = part.groups ?? {};
    const script = page.lastIndexOf("<script", part.index);
    const segmentOpen = `<div hidden id="${segment}">`;
    const segmentStart = page.indexOf(segmentOpen);
    const segmentEnd = page.lastIndexOf("</div>", script);
    const content = page.slice(segmentStart + segmentOpen.length, segmentEnd);
    const scriptEnd =
      page.indexOf("</script>", part.index) + "</script>".length;
    // The streamed part and its script leave; its content takes the placeholder's place.
    page = page.slice(0, segmentStart) + page.slice(scriptEnd);
    const template = `<template id="${boundary}"></template>`;
    const placeholder = page.indexOf(template);
    let depth = 1;
    let close = -1;
    for (const mark of page.slice(placeholder).matchAll(boundaryMarks)) {
      depth += mark[0] === "<!--/$-->" ? -1 : 1;
      if (depth === 0) {
        close = placeholder + mark.index;
        break;
      }
    }
    const open = page.lastIndexOf("<!--$?-->", placeholder);
    page = `${page.slice(0, open)}<!--$-->${content}${page.slice(close)}`;
    part = streamedPart.exec(page);
  }
  return page;
};

interface Page {
  status: number;
  html: string;
}

/** The page most recently asked for, rendered or not. */
let previous: Promise<unknown> = Promise.resolve();

/** The page at `path` as `email` sees it, once `earlier` has settled. */
const renderAfter = async (
  earlier: Promise<unknown>,
  path: string,
  email: string
): Promise<Page> => {
  try {
    await earlier;
  } catch {
    // The test that asked for it sees why it failed.
  }
  const response = await exports.default.fetch(`${origin}${path}`, {
    headers: {
      "cf-access-jwt-assertion": await accessJwt(email),
    },
  });
  const html = settled(await response.text());
  return { status: response.status, html: html.replaceAll(scripts, "") };
};

/**
 * The page at `path`, as `email` (a staff member) sees it once everything
 * it reads is in (`settled`): its markup without its scripts, so the data
 * sent along for hydration doesn't count as shown.
 *
 * Pages render one at a time, even when a test asks for several at once. In
 * the test pool, the Worker loads the app's modules on demand, over I/O owned
 * by the request that first needs each one, and a second request needing the
 * same module waits on that I/O. Once the pool has loaded a few hundred
 * modules more than the admin alone (as the Select's icon library would,
 * were it not pre-bundled in vite.test.config.ts), workerd cancels that
 * second request as hung. Built and dev Workers load modules differently and
 * render Selects concurrently fine.
 */
export const page = async (
  path: string,
  email = "staff@grasp.test"
): Promise<Page> => {
  const rendered = renderAfter(previous, path, email);
  previous = rendered;
  return await rendered;
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
  /** The page's origin, as the browser sends it: the admin's own unless given. */
  from?: string;
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
  data: Data,
  { email = "staff@grasp.test", from = origin }: Caller = {}
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
        origin: from,
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
