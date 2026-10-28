import { describe, expect, it } from "vite-plus/test";

import Gateway from "../src/index.ts";

// The connect gateway's threat model (GRA-1217), tried here against a
// stand-in for the clients' dispatch namespace: no dispatch namespace runs
// locally. That it holds on Cloudflare itself is the GRA-430 run's
// (scripts/qualify/run.ts, its `gateway` step).
// 1. A core reaches a script other than the one its binding's props name.
// 2. A binding with no props, or props naming a script that isn't a client
//    connect's, reaches anything.
// 3. An error names a script, the props or the namespace.
// 4. A name that isn't one of connect's methods is forwarded.

const own = "gabc123-grasp-os-connect";
const other = "gdef456-grasp-os-connect";

/** What each stand-in connect was asked, by script. */
const asked = new Map<string, unknown[][]>();

/** A stand-in connect: answers its own script name, records what it was asked. */
const connectStandIn = (script: string) => ({
  name: async (...args: unknown[]) => {
    asked.set(script, [...(asked.get(script) ?? []), args]);
    return await Promise.resolve(script);
  },
  fetch: async () => await Promise.resolve(new Response(script)),
  fail: async () =>
    await Promise.reject(
      Object.assign(new TypeError("connect's own"), { code: "x" })
    ),
});

/** The clients' namespace, as the gateway's binding gives it: a script it hasn't got answers as Cloudflare's does. */
/** Scripts the namespace has: two clients' connects, and scripts that aren't any connect. */
const present: ReadonlySet<string> = new Set([
  own,
  other,
  "grasp-os-router",
  "gabc123-grasp-os-core",
]);

const clients = {
  get: (script: string) =>
    present.has(script)
      ? connectStandIn(script)
      : {
          name: async () =>
            await Promise.reject(new Error(`Worker not found: ${script}`)),
        },
};

/** The gateway as a binding with `props` gives it to a core. */
const gatewayFor = (props: unknown): object => {
  const context = {
    props,
    waitUntil: () => {},
    passThroughOnException: () => {},
  };
  const made: unknown = Reflect.construct(Gateway, [
    context,
    { CLIENTS: clients },
  ]);
  if (typeof made !== "object" || made === null) {
    throw new Error("expected the gateway");
  }
  return made;
};

/** Calls `method` on `gateway` as a core's binding would. */
const call = async (
  gateway: object,
  method: string,
  ...args: unknown[]
): Promise<unknown> => {
  const found: unknown = Reflect.get(gateway, method);
  if (typeof found !== "function") {
    throw new TypeError(`The gateway has no ${method}`);
  }
  return await Reflect.apply(found, gateway, args);
};

const failure = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return "answered";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("the connect gateway", () => {
  it("calls every method on the script its props name, whatever the caller passes", async () => {
    const gateway = gatewayFor({ script: own });
    asked.clear();

    const named = await call(gateway, "name", other, { script: other });
    const response = await call(
      gateway,
      "fetch",
      new Request("https://connect/")
    );
    const fetched = response instanceof Response ? await response.text() : null;

    expect({
      named,
      fetched,
      askedOwn: asked.get(own),
      askedOther: asked.get(other),
    }).toStrictEqual({
      named: own,
      fetched: own,
      askedOwn: [[other, { script: other }]],
      askedOther: undefined,
    });
  });

  it("serves no binding without props naming a client connect, and names nothing when it refuses", async () => {
    const refusals = await Promise.all(
      [
        undefined,
        {},
        { script: 42 },
        { script: "grasp-os-router" },
        { script: "gabc123-grasp-os-core" },
        { script: `${own}/../x` },
        { script: "gmissing-grasp-os-connect" },
      ].map(
        async (props) =>
          await failure(async () => await call(gatewayFor(props), "name"))
      )
    );

    expect(new Set(refusals)).toStrictEqual(new Set(["connect unavailable"]));
  });

  it("passes connect's own errors on as they are", async () => {
    const gateway = gatewayFor({ script: own });
    let thrown: unknown;
    try {
      await call(gateway, "fail");
    } catch (error) {
      thrown = error;
    }

    expect({
      kind: thrown instanceof TypeError,
      message: thrown instanceof Error ? thrown.message : undefined,
    }).toStrictEqual({ kind: true, message: "connect's own" });
  });

  it("forwards no name that isn't one of connect's methods", () => {
    const gateway = gatewayFor({ script: own });
    const names = [
      "then",
      "constructor",
      "connect",
      "toString",
      "toJSON",
      "valueOf",
      "_secret",
      "ctx",
      "env",
    ];
    // Not one of them reaches connect: `then` above all, or an RPC answer
    // of the gateway would be awaited into it.
    const reachingConnect = names.filter((name) => {
      const found: unknown = Reflect.get(gateway, name);
      return typeof found === "function" && found.name === "";
    });

    expect({
      thenable: typeof Reflect.get(gateway, "then"),
      reachingConnect,
      symbol: typeof Reflect.get(gateway, Symbol.iterator),
    }).toStrictEqual({
      thenable: "undefined",
      reachingConnect: [],
      symbol: "undefined",
    });
  });
});
