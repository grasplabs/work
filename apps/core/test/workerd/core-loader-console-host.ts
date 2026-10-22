import { openAnswer, quietLoader } from "@grasp-os/shared/quiet-loader";
import { DurableObject, exports } from "cloudflare:workers";

import type { SandboxedEnv } from "../../src/sandboxed.ts";

// The host of an App's server class, as core's `App` object is
// (apps/core/src/app.ts, `loadServer`): the class from a Loader isolate with
// a tail, run as a facet and called as `invokeServer` calls it, its answer
// opened as it opens it. `quiet` loads it through `quietLoader`, `loud` as
// the Loader gives it, `untailed` through `quietLoader` with no tail.

const settings = {
  compatibilityDate: "2026-09-15",
  compatibilityFlags: ["nodejs_compat"],
  env: {},
  globalOutbound: null,
};

/** What an App's class does, by route: each way it can have workerd report. Not an alarm: a facet can't set one. */
export const objectCases = [
  "fail",
  "timer",
  "constructor",
  "console",
  "getter",
  "waitUntil",
  "kept",
  "block",
] as const;

export type ObjectCase = (typeof objectCases)[number];

export const isObjectCase = (name: string): name is ObjectCase =>
  objectCases.some((known) => known === name);

/** The method of the App's class each case calls. */
const methodOf: Readonly<Record<ObjectCase, string>> = {
  fail: "fail",
  timer: "timer",
  constructor: "fail",
  console: "console",
  getter: "read",
  waitUntil: "waitUntil",
  kept: "keptWaitUntil",
  block: "block",
};

/** What the App's class's constructor does beyond making its base, by case. */
const constructorOf = (name: ObjectCase): string => {
  if (name === "constructor") {
    return "constructor(ctx, env) { super(ctx, env); throw new Error(value); }";
  }
  if (name === "kept") {
    // The context its constructor is given, kept: the runtime's own would
    // report what its waitUntil is handed.
    return "constructor(ctx, env) { super(ctx, env); this.state = ctx; }";
  }
  return "";
};

/**
 * An App's server class, doing what `name` says with `value`: throwing from
 * a method, an accessor, a timer, its constructor or a
 * `blockConcurrencyWhile` callback, rejecting what it hands a context's
 * `waitUntil`, or logging.
 */
const sourceOf = (
  name: ObjectCase,
  value: string
): string => `import { DurableObject } from "cloudflare:workers";
const value = ${JSON.stringify(value)};
export class App extends DurableObject {
  ${constructorOf(name)}
  fail() {
    throw Object.assign(new TypeError(value), { details: { retryAfterMs: 5 } });
  }
  async timer() {
    setTimeout(() => { throw new Error(value); }, 0);
    await scheduler.wait(100);
    return "timed";
  }
  console() {
    console.log(value);
    return "logged";
  }
  // An accessor where workerd reads the method it calls. Workerd calls only
  // what the class's prototype has: an instance's own property is no
  // method of its ("does not implement the method"), so isn't a way.
  get read() {
    if (${JSON.stringify(name)} === "getter") {
      throw new TypeError(value);
    }
    return () => "read";
  }
  async waitUntil() {
    this.ctx.waitUntil(Promise.reject(new Error(value)));
    await scheduler.wait(100);
    return "waited";
  }
  async keptWaitUntil() {
    this.state.waitUntil(Promise.reject(new Error(value)));
    await scheduler.wait(100);
    return "waited";
  }
  async block() {
    await this.ctx.blockConcurrencyWhile(async () => {
      throw new TypeError(value);
    });
    return "never";
  }
}
`;

const modes = ["quiet", "loud", "untailed"] as const;

type Mode = (typeof modes)[number];

export const isMode = (name: string): name is Mode =>
  modes.some((known) => known === name);

/** The tail's entrypoint: a function of the runtime's, found by name. */
const tailOf = (): Fetcher[] => {
  const make: unknown = Reflect.get(exports, "TestTail");
  if (typeof make !== "function") {
    throw new TypeError("TestTail isn't exported.");
  }
  // SAFETY: the runtime's entrypoint function answers a Fetcher.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return [Reflect.apply(make, exports, [{}]) as Fetcher];
};

export class Host extends DurableObject<SandboxedEnv> {
  /** What the case answers or throws, as JSON, with the value it wrote. */
  async run(name: ObjectCase, mode: Mode): Promise<string> {
    const value = `${mode}-${name}-9e2a`;
    const code = {
      ...settings,
      mainModule: "app.js",
      modules: { "app.js": sourceOf(name, value) },
      tails: mode === "untailed" ? [] : tailOf(),
    };
    try {
      const loader =
        mode === "loud" ? this.env.LOADER : quietLoader(this.env.LOADER);
      const cls = loader.load(code).getDurableObjectClass("App");
      const facet = this.ctx.facets.get(
        `server-${crypto.randomUUID()}`,
        () => ({ class: cls, id: "server" })
      );
      const method: unknown = Reflect.get(facet, methodOf[name]);
      if (typeof method !== "function") {
        return JSON.stringify({ value, answered: null });
      }
      const answered = await openAnswer(await Reflect.apply(method, facet, []));
      return JSON.stringify({ value, answered });
    } catch (error) {
      const details: unknown =
        error instanceof Error ? Reflect.get(error, "details") : undefined;
      return JSON.stringify({
        value,
        thrown: {
          kind: error instanceof TypeError ? "TypeError" : "other",
          message: error instanceof Error ? error.message : "",
          details: details ?? null,
        },
      });
    }
  }
}
