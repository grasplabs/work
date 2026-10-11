import type { RpcTarget } from "capnweb";
import { RpcStub } from "capnweb";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { CoreRpcTarget } from "../src/rpc-target.ts";
import { browserApi } from "../src/rpc.ts";
import type { CoreRpc } from "../src/rpc.ts";
import { approvalApp } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// Every object a browser can call over core's connection, held to the
// bounds every argument of a call gets (rpc-target.ts). How that could
// fail, each tried below or by the type check of `calls`:
// - A getter hands out a target that derives from RpcTarget some other
//   way: through another module (workerflow's `Subscription`), which the
//   lint rule can't follow. Its methods would take arguments as deep and
//   as big as pushes and pipelines build them.
// - A method answers a workerd stub (a Durable Object's, a service's, a
//   Subscription's): Cap'n Web forwards the browser's calls straight to
//   it, past any bounded base, to code that trusts its caller.
// - A method answers a function, or data holding a target, a stub or a
//   function: each is as callable by the browser as a target is.
// - A target only a call hands out (`chats.watch`, `screens.watchRuns`)
//   is never looked at, because nothing gets to it without arguments.
//
// So the objects are built as rpc.ts builds them for a connection
// (`browserApi`), signed out and signed in, and walked: every getter of
// every target reached, read; every method that may answer something
// callable, called (`calls`, which the type check makes list each one);
// whatever comes back, looked through. Everything callable it finds must
// be a CoreRpcTarget. A getter or method added later is walked without a
// change here, or the type check asks for its call.

const idp = mockIdp();

// What the type check counts as a method that may answer something
// callable, read from what the method is declared to answer. One that
// answers `any` may answer anything; one typed `unknown` is taken to
// answer data, as plain values passed on are typed. A stub hidden behind
// a cast to data isn't asked for: a review catches that, not this.

/** Whether `T` is `any`. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** What holds nothing callable: the data a call answers. */
type Leaf =
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined
  | Date
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  // A download (`audit.export`): read, not called.
  | ReadableStream;

/** How deep the check looks: past any data a call answers. */
type Deep = [0, 0, 0, 0, 0, 0, 0, 0];

/**
 * `true` if `T` may hold something a browser could call: a function, a
 * target or a stub (an object with a method), at any depth up to
 * {@link Deep}.
 */
type HoldsCallable<T, Depth extends unknown[] = []> =
  IsAny<T> extends true
    ? true
    : Depth["length"] extends Deep["length"]
      ? false
      : T extends Leaf
        ? false
        : T extends (...args: never) => unknown
          ? true
          : T extends readonly (infer Item)[]
            ? HoldsCallable<Item, [...Depth, 0]>
            : T extends ReadonlyMap<infer K, infer V>
              ? HoldsCallable<K | V, [...Depth, 0]>
              : T extends ReadonlySet<infer Item>
                ? HoldsCallable<Item, [...Depth, 0]>
                : T extends object
                  ? true extends {
                      [K in keyof T]-?: HoldsCallable<T[K], [...Depth, 0]>;
                    }[keyof T]
                    ? true
                    : false
                  : false;

/** What a browser calls on a target: its members but Cap'n Web's brand. */
type Member<T> = Exclude<keyof T, keyof RpcTarget> & string;

/** A bounded target, as its type says: what the type check looks into. */
type Bounded = InstanceType<typeof CoreRpcTarget>;

/**
 * The path, from `T`, of every method that may answer something
 * callable, through every getter and every answer that is a bounded
 * target: as `walk` names them (`authenticate.chats.watch`). Anything
 * else callable a getter or an answer holds, the walk finds unbounded,
 * so there's nothing past it to call.
 */
type CallableAnswers<
  T,
  Prefix extends string = "",
  Depth extends unknown[] = [],
> = Depth["length"] extends Deep["length"]
  ? never
  : {
      [K in Member<T>]: T[K] extends (...args: never) => infer Answer
        ? true extends HoldsCallable<Awaited<Answer>>
          ?
              | `${Prefix}${K}`
              | (Awaited<Answer> extends Bounded
                  ? CallableAnswers<
                      Awaited<Answer>,
                      `${Prefix}${K}.`,
                      [...Depth, 0]
                    >
                  : never)
          : never
        : T[K] extends Bounded
          ? CallableAnswers<T[K], `${Prefix}${K}.`, [...Depth, 0]>
          : never;
    }[Member<T>];

/** What `T`'s member `K` hands out: a getter's value, a method's answer. */
type Next<T, K extends string> = K extends keyof T
  ? T[K] extends (...args: never) => infer Answer
    ? Awaited<Answer>
    : T[K]
  : never;

/** The target `Path`'s last method is called on. */
type Owner<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Owner<Next<T, Head>, Rest>
  : T;

/** What each call is made with, beyond what it makes itself. */
interface Fixture {
  /** An App with the approval workflow, if the person built it. */
  app: string;
  /** What a call handed out that holds something, to let go of after. */
  held: Disposable[];
}

/**
 * A page's callback, as a stub, as Cap'n Web hands one to core, typed as
 * the callback core's methods take; and once something was pushed to it.
 */
const pageStub = () => {
  const pushed = Promise.withResolvers<true>();
  // Calling a stub answers a promise, which core never waits on.
  // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- see above
  const stub: () => void = new RpcStub(() => {
    pushed.resolve(true);
  });
  return { stub, pushed: pushed.promise };
};

/** What's held, kept to be released once the walk is done. */
const holding = <T extends Disposable>(held: Disposable[], value: T): T => {
  held.push(value);
  return value;
};

/**
 * How to call each method that may answer something callable, as a page
 * calls it. The type check fails while one is missing, or one is listed
 * that isn't one.
 */
const calls = {
  authenticate: (core) => core.authenticate(),
  "authenticate.chats.watch": async (chats, { held }) => {
    const { id } = await chats.create("Walked");
    const page = pageStub();
    const subscription = holding(held, await chats.watch(id, null, page.stub));
    // The chat as it is now, pushed at once: let go of after that, as a
    // page does, not while it's on its way.
    await page.pushed;
    return subscription;
  },
  "authenticate.screens.watchRuns": async (screens, { app, held }) =>
    holding(held, await screens.watchRuns(app, "approval", pageStub().stub)),
} satisfies {
  [Path in CallableAnswers<CoreRpc>]: (
    owner: Owner<CoreRpc, Path>,
    fixture: Fixture
  ) => unknown;
};

/** Each call, by its path, to look up as the walk reaches a method. */
const callsByPath = new Map<
  string,
  (owner: never, fixture: Fixture) => unknown
>(Object.entries(calls));

/** A value that holds nothing callable and isn't looked into. */
const isLeaf = (value: object): boolean =>
  value instanceof Date ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value) ||
  value instanceof Blob ||
  value instanceof ReadableStream;

/** Plain data's parts: an array's, a map's, a set's, a plain object's. */
const partsOf = (value: object): [string, unknown][] | undefined => {
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => [String(index), item]);
  }
  if (value instanceof Map) {
    return [...value].flatMap(([key, item]: [unknown, unknown], index) => [
      [`key ${index}`, key],
      [String(key), item],
    ]);
  }
  if (value instanceof Set) {
    return [...value].map((item: unknown, index) => [String(index), item]);
  }
  const prototype: unknown = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? Object.entries(value)
    : undefined;
};

/** What the walk found, from one root. */
interface Walked {
  /** Every target reached, by where: `path: class`. */
  targets: string[];
  /** Every method of `calls` it called, by path. */
  called: string[];
  /** The methods of `calls` that refused, by path. */
  refused: string[];
  /** Everything callable it found that isn't a CoreRpcTarget. */
  unbounded: string[];
}

/**
 * Walks everything a browser reaches from `root`: each target's getters
 * and the methods in `calls`, down every target they hand out, and the
 * data around them.
 */
const walk = async (root: CoreRpc, fixture: Fixture): Promise<Walked> => {
  const walked: Walked = {
    targets: [],
    called: [],
    refused: [],
    unbounded: [],
  };
  const seen = new WeakSet<object>();

  const visit = async (path: string, value: unknown): Promise<void> => {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    ) {
      return;
    }
    if (value instanceof CoreRpcTarget) {
      if (!seen.has(value)) {
        seen.add(value);
        walked.targets.push(`${path || "(root)"}: ${value.constructor.name}`);
        // oxlint-disable-next-line no-use-before-define -- the two walk each other
        await members(path, value);
      }
      return;
    }
    // A stub's properties are its remote's: only what can't reach it is
    // read from here on (`typeof`, its tag, its prototype).
    if (typeof value === "function") {
      walked.unbounded.push(`${path}: a function`);
      return;
    }
    if (isLeaf(value)) {
      return;
    }
    const parts = partsOf(value);
    if (parts === undefined) {
      walked.unbounded.push(
        `${path}: ${Object.prototype.toString.call(value)}, not a CoreRpcTarget`
      );
      return;
    }
    await Promise.all(
      parts.map(async ([key, part]) => {
        await visit(`${path}[${key}]`, part);
      })
    );
  };

  /** What one member of a target hands out: a getter's value, a call's answer. */
  const member = async (
    at: string,
    target: object,
    [name, property]: [string, PropertyDescriptor]
  ): Promise<void> => {
    if (property.get !== undefined) {
      await visit(at, Reflect.get(target, name));
      return;
    }
    if (typeof property.value !== "function") {
      await visit(at, property.value);
      return;
    }
    const call = callsByPath.get(at);
    if (call === undefined) {
      return;
    }
    let answer: unknown;
    try {
      // SAFETY: `calls` types each by the target its path reaches, which
      // is this one: the path is where the walk found it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      answer = await call(target as never, fixture);
    } catch {
      walked.refused.push(at);
      return;
    }
    walked.called.push(at);
    await visit(at, answer);
  };

  /**
   * Every member a browser may reach on `target`: what its class and the
   * classes between it and CoreRpcTarget declare, the nearest of each name
   * as Cap'n Web finds it.
   */
  const members = async (path: string, target: object): Promise<void> => {
    const declared = new Map<string, PropertyDescriptor>();
    for (
      let prototype: object | null = Reflect.getPrototypeOf(target);
      prototype !== null && prototype !== CoreRpcTarget.prototype;
      prototype = Reflect.getPrototypeOf(prototype)
    ) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const property = Reflect.getOwnPropertyDescriptor(prototype, name);
        if (
          name !== "constructor" &&
          property !== undefined &&
          !declared.has(name)
        ) {
          declared.set(name, property);
        }
      }
    }
    await Promise.all(
      [...declared].map(async (named) => {
        const at = path === "" ? named[0] : `${path}.${named[0]}`;
        await member(at, target, named);
      })
    );
  };

  await visit("", root);
  return walked;
};

/**
 * Builds what a browser's connection reaches with `cookie`, as rpc.ts
 * builds it, walks it, and lets go of the connection.
 */
const walkConnection = async (cookie?: string, app = ""): Promise<Walked> => {
  const { 0: client, 1: server } = new WebSocketPair();
  client.accept();
  server.accept();
  const fixture: Fixture = { app, held: [] };
  try {
    const headers = new Headers(cookie === undefined ? {} : { cookie });
    return await walk(await browserApi(env, headers, server), fixture);
  } finally {
    for (const held of fixture.held) {
      held[Symbol.dispose]();
    }
    // Ends the connection's session check, as a closed page does.
    client.close();
  }
};

describe("what a browser reaches over core's connection", () => {
  it("is bounded signed out: nothing past the sign-in", async () => {
    const walked = await walkConnection();

    expect(walked.unbounded).toStrictEqual([]);
    expect(walked.targets).toStrictEqual(["(root): CoreRpc"]);
    expect(walked.refused).toStrictEqual(["authenticate"]);
  });

  it("is bounded signed in, every target, through every call that hands one out", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await approvalApp(builder);

    const walked = await walkConnection(builder.session, app);

    expect(walked.unbounded).toStrictEqual([]);
    expect(walked.refused).toStrictEqual([]);
    expect(walked.called.toSorted()).toStrictEqual(
      Object.keys(calls).toSorted()
    );
    // The getters' targets and those the calls handed out: the walk got
    // past the session.
    expect(walked.targets).toStrictEqual(
      expect.arrayContaining([
        "authenticate: SessionRpc",
        "authenticate.apps.files: AppFilesRpc",
        "authenticate.workflows.params: WorkflowParamsRpc",
        "authenticate.chats.watch: RunSubscription",
        "authenticate.screens.watchRuns: RunSubscription",
      ])
    );
  });

  it.each(["admin", "user"] as const)(
    "is bounded for someone with the %s role",
    async (role) => {
      const person = await signedInApi(idp, role);

      const walked = await walkConnection(person.session);

      expect(walked.unbounded).toStrictEqual([]);
      expect(walked.targets).toContain(
        "authenticate.chats.watch: RunSubscription"
      );
    }
  );
});
