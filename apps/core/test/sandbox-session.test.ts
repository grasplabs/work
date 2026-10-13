import { whenAborted } from "@grasp-os/shared/deadline";
import { rpcArgumentDepth } from "@grasp-os/shared/screens";
import { RpcSession, RpcTarget, WebSocketTransport } from "capnweb";
import { describe, expect, it } from "vite-plus/test";

import {
  capability,
  runInSession,
  sandboxVerdictOf,
  sessionForwarder,
} from "../src/sandbox-session.ts";
import { sandboxCpuHeader } from "../src/sandboxed.ts";

// What reaches a capability through a sandbox session (on-prem) arrives
// over Cap'n Web from the sandbox host, where App code runs: the forwarder
// core hands the session holds every argument to the session's bounds
// before the capability's own code runs, and refuses once its call is over.

/** A value `levels` deep. */
const deep = (levels: number): unknown =>
  levels <= 1 ? 1 : [deep(levels - 1)];

/** A capability counting what reached it. */
const counted = () => {
  const reached: unknown[] = [];
  const target = {
    take: (value: unknown): number => reached.push(value),
  };
  return { reached, target };
};

/** The forwarder's `take`, as the session calls it. */
const takeOf = (forwarder: object) => {
  const take: unknown = Reflect.get(forwarder, "take");
  if (typeof take !== "function") {
    throw new TypeError("The forwarder has no take");
  }
  return async (value: unknown): Promise<unknown> =>
    await Promise.resolve(Reflect.apply(take, forwarder, [value]));
};

describe("a session's forwarder to a capability", () => {
  it("refuses an argument deeper than a session's message lets one be", async () => {
    const { reached, target } = counted();
    const take = takeOf(
      sessionForwarder(capability(target, ["take"]), () => true)
    );
    await expect(take(deep(3))).resolves.toBe(1);
    await expect(take(deep(rpcArgumentDepth + 5))).rejects.toMatchObject({
      code: "request.too_deep",
    });
    expect(reached).toHaveLength(1);
  });

  it("refuses an argument of no kind a call takes", async () => {
    const { reached, target } = counted();
    const take = takeOf(
      sessionForwarder(capability(target, ["take"]), () => true)
    );
    const odd = { x: 1 };
    Object.setPrototypeOf(odd, { polluted: true });
    await expect(take(odd)).rejects.toMatchObject({
      code: "request.unsupported_value",
    });
    expect(reached).toHaveLength(0);
  });

  it("refuses every call once its call is over", async () => {
    const { reached, target } = counted();
    let live = true;
    const take = takeOf(
      sessionForwarder(capability(target, ["take"]), () => live)
    );
    await expect(take(1)).resolves.toBe(1);
    live = false;
    await expect(take(2)).rejects.toThrow("is over");
    expect(reached).toStrictEqual([1]);
  });
});

describe("why the sandbox ended a call", () => {
  it("is never what an error says of itself, as one App code throws may", () => {
    const forged = Object.assign(new Error("forged"), {
      sandboxVerdict: "cpu",
    });
    expect(sandboxVerdictOf(forged)).toBeUndefined();
  });
});

/** A capability the isolate was given, as a test's host calls it. */
interface Kept {
  ping: (n: number) => unknown;
  dup: () => { ping: (n: number) => unknown };
}

/** A test's sandbox host's session: its `run` does what `answer` does. */
class SessionMain extends RpcTarget {
  readonly #answer: (stubs: Record<string, Kept>) => unknown;

  constructor(answer: (stubs: Record<string, Kept>) => unknown) {
    super();
    this.#answer = answer;
  }

  run(_call: unknown, stubs: Record<string, Kept>): unknown {
    return this.#answer(stubs);
  }
}

/**
 * A sandbox host in this isolate, over a real WebSocket and Cap'n Web: its
 * call answers at once, and keeps the capability it was given to call it
 * `afterMs` later, as a timer of the isolate's may (plain workerd cancels
 * those when the call returns, so only a host of the test's own shows it).
 */
const hostCallingLater = (afterMs: number): Fetcher => {
  const main = new SessionMain((stubs) => {
    const kept = stubs.c0?.dup();
    setTimeout(() => {
      void Promise.resolve(kept?.ping(7)).catch(() => {
        // Refused, as it should be.
      });
    }, afterMs);
    return "returned";
  });
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (!request.url.endsWith("/session")) {
        return await Promise.resolve(new Response("{}", { status: 404 }));
      }
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      void new RpcSession(new WebSocketTransport(server), main);
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: {
          [sandboxCpuHeader]: request.headers.get(sandboxCpuHeader) ?? "",
        },
      });
    },
    connect: () => {
      throw new Error("Not a socket host");
    },
  };
};

describe("a call in a session that stays open for what it nested", () => {
  it("refuses its capabilities once it answered", async () => {
    const reached: unknown[] = [];
    const probe = {
      ping: (value: unknown): unknown => reached.push(value),
    };
    const answer = await runInSession(
      hostCallingLater(100),
      {
        mainModule: "m.js",
        modules: { "m.js": "" },
        entrypoint: "E",
        method: "go",
        args: [{ capability: capability(probe, ["ping"]) }],
        owner: "app-test",
        cpuMs: 1000,
        wallMs: 5000,
      },
      {
        nesting: {
          open: () => {
            // Nothing is nested here.
          },
          answered: () => {
            // The answer is what the call returns.
          },
          drain: async () => {
            await scheduler.wait(500);
          },
        },
      }
    );
    expect(answer).toBe("returned");
    expect(reached).toStrictEqual([]);
  });
});

/** How a test's supervisor speaks of a session whose call failed. */
type Said =
  /** Its process is ending; its verdict is kept `afterMs` after core first asks, or never. */
  | { state: "ending"; afterMs?: number }
  /** It still runs: the App's code threw. */
  | { state: "running" }
  /** It doesn't answer at all, until core gives up on the request. */
  | { state: "stalled" };

/**
 * A sandbox host whose isolate fails its call: the call's error reaches
 * core over a socket still open, and the supervisor answers for the
 * session as `said` says (it judges a crash only once its process has
 * exited). Counts how often core asked.
 */
const hostFailing = (said: Said) => {
  let firstAsked: number | undefined;
  let asked = 0;
  const main = new SessionMain(() => {
    throw new Error("internal error; the isolate's process is exiting");
  });
  const verdictAnswer = async (signal: AbortSignal): Promise<Response> => {
    asked += 1;
    if (said.state === "stalled") {
      return await whenAborted(signal);
    }
    firstAsked ??= Date.now();
    if (
      said.state === "ending" &&
      said.afterMs !== undefined &&
      Date.now() - firstAsked >= said.afterMs
    ) {
      return Response.json({
        verdict: "crashed",
        message: "The App's code crashed its sandbox.",
      });
    }
    return Response.json({ verdict: null, state: said.state });
  };
  const host: Fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/verdict/")) {
        return await verdictAnswer(request.signal);
      }
      if (pathname !== "/session") {
        return await Promise.resolve(new Response("{}", { status: 200 }));
      }
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      void new RpcSession(new WebSocketTransport(server), main);
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: {
          [sandboxCpuHeader]: request.headers.get(sandboxCpuHeader) ?? "",
        },
      });
    },
    connect: () => {
      throw new Error("Not a socket host");
    },
  };
  return { host, asked: () => asked };
};

/** A call that fails on `host`: how it ended, and its verdict. */
const failedOn = async (host: Fetcher, signal?: AbortSignal) => {
  try {
    await runInSession(
      host,
      {
        mainModule: "m.js",
        modules: { "m.js": "" },
        entrypoint: "E",
        method: "go",
        args: [],
        owner: "app-test",
        cpuMs: 1000,
        wallMs: 5000,
      },
      { signal }
    );
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      verdict: sandboxVerdictOf(error) ?? null,
    };
  }
  return { message: "answered", verdict: null };
};

describe("a call that fails while its session looks open", () => {
  it("is the sandbox's verdict when the supervisor, its process ending, keeps one a moment later", async () => {
    const { host } = hostFailing({ state: "ending", afterMs: 300 });

    await expect(failedOn(host)).resolves.toStrictEqual({
      message: "The App's code crashed its sandbox.",
      verdict: "crashed",
    });
  });

  it("is the App's own error when its process ends with no verdict kept", async () => {
    const { host, asked } = hostFailing({ state: "ending" });
    const started = Date.now();

    await expect(failedOn(host)).resolves.toStrictEqual({
      message: "internal error; the isolate's process is exiting",
      verdict: null,
    });
    // Asked again while it waits, and for about its 1 s, no longer.
    expect(asked()).toBeGreaterThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("is the App's own error at once when the supervisor says its session still runs", async () => {
    const { host, asked } = hostFailing({ state: "running" });

    await expect(failedOn(host)).resolves.toStrictEqual({
      message: "internal error; the isolate's process is exiting",
      verdict: null,
    });
    // Asked once, with no wait for a verdict.
    expect(asked()).toBe(1);
  });

  it("is the App's own error by the wait's end when the supervisor doesn't answer", async () => {
    const { host } = hostFailing({ state: "stalled" });
    const started = Date.now();
    const failed = await failedOn(host);

    expect(failed).toStrictEqual({
      message: "internal error; the isolate's process is exiting",
      verdict: null,
    });
    // About the 1 s wait, every ask included: not a request's timeout each.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ends at once when its caller gives up while it waits for a verdict", async () => {
    const { host } = hostFailing({ state: "stalled" });
    const caller = new AbortController();
    const started = Date.now();
    setTimeout(() => {
      caller.abort(new Error("The caller gave up."));
    }, 200);
    const failed = await failedOn(host, caller.signal);

    expect(failed).toStrictEqual({
      message: "The caller gave up.",
      verdict: null,
    });
    expect(Date.now() - started).toBeLessThan(700);
  });
});
