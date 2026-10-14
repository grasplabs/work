// oxlint-disable max-classes-per-file -- the targets these sessions serve, each a few lines
import { RpcSession, RpcTarget } from "capnweb";
import type { RpcStub } from "capnweb";
import { describe, expect, it } from "vite-plus/test";

import {
  accountedTransport,
  heldPool,
  rpcCopyNodeBounds,
} from "../src/rpc-accounting.ts";
import type { HeldPool, TextRpcTransport } from "../src/rpc-accounting.ts";

// Real Cap'n Web sessions behind the accountant, each on an in-memory pair
// of transports: what a peer's calls make us hold, across sessions sharing
// one pool, and how our stubs come and go as the peer releases them.

/** One direction of an in-memory connection: messages queued in order. */
const channel = () => {
  const queued: string[] = [];
  let waiting: ((message: string) => void) | undefined;
  let closed: Error | undefined;
  let closeWaiter: ((error: Error) => void) | undefined;
  return {
    deliver: (message: string): void => {
      if (waiting === undefined) {
        queued.push(message);
      } else {
        const wake = waiting;
        waiting = undefined;
        wake(message);
      }
    },
    close: (error: Error): void => {
      closed ??= error;
      closeWaiter?.(closed);
    },
    take: async (): Promise<string> => {
      const next = queued.shift();
      if (next !== undefined) {
        return next;
      }
      if (closed !== undefined) {
        throw closed;
      }
      // oxlint-disable-next-line promise/avoid-new -- a queue has no promise form
      return await new Promise<string>((resolve, reject) => {
        waiting = resolve;
        closeWaiter = reject;
      });
    },
  };
};

const limits = {
  ...rpcCopyNodeBounds,
  maxMessageBytes: 1024 * 1024,
  maxSessionBytes: 4 * 1024 * 1024,
};

/** A server behind the accountant on `pool`, and a client to call it. */
const connect = <Api extends object>(main: RpcTarget, pool: HeldPool) => {
  const toServer = channel();
  const toClient = channel();
  const ended: { reason: string | undefined } = { reason: undefined };
  const end = (error: Error): void => {
    ended.reason ??= error.message;
    toServer.close(error);
    toClient.close(error);
  };
  const serverSide: TextRpcTransport = {
    send: (message) => {
      toClient.deliver(message);
    },
    receive: async () => await toServer.take(),
    abort: (reason) => {
      end(reason instanceof Error ? reason : new Error("aborted"));
    },
  };
  const server = new RpcSession(
    accountedTransport(
      serverSide,
      limits,
      (refusal) => new Error(refusal),
      pool
    ),
    main
  );
  const client: RpcStub<Api> = new RpcSession<Api>({
    send: (message: string) => {
      toServer.deliver(message);
    },
    receive: async () => await toClient.take(),
  }).getRemoteMain();
  return { client, ended, server };
};

class Files extends RpcTarget {
  // Cap'n Web exposes prototype methods only, so this can't be static.
  // oxlint-disable-next-line class-methods-use-this
  source(): string {
    return "s".repeat(1000 * 1024);
  }

  // oxlint-disable-next-line class-methods-use-this
  ping(): string {
    return "pong";
  }
}

/**
 * A peer that speaks Cap'n Web by hand on `connection`, as a page someone
 * changed can: it calls `source`, pulls the answer, and never releases it
 * (a real client releases an answer as soon as it has it).
 */
const hoard = (connection: ReturnType<typeof rawConnect>) => {
  let pushed = 0;
  return {
    call: async (method: string): Promise<unknown> => {
      pushed += 1;
      const id = pushed;
      const answered = connection.answer(id);
      connection.send(["push", ["pipeline", 0, [method], []]]);
      connection.send(["pull", id]);
      return await answered;
    },
  };
};

/** A server behind the accountant on `pool`, spoken to by hand. */
const rawConnect = (main: RpcTarget, pool: HeldPool) => {
  const toServer = channel();
  const ended: { reason: string | undefined } = { reason: undefined };
  const waiting = new Map<number, (value: unknown) => void>();
  const serverSide: TextRpcTransport = {
    send: (message) => {
      const parsed: unknown = JSON.parse(message);
      if (Array.isArray(parsed) && parsed[0] === "resolve") {
        waiting.get(Number(parsed[1]))?.(parsed[2]);
      }
    },
    receive: async () => await toServer.take(),
    abort: (reason) => {
      ended.reason ??= reason instanceof Error ? reason.message : "aborted";
      toServer.close(new Error("closed"));
      for (const wake of waiting.values()) {
        wake("ended");
      }
    },
  };
  const server = new RpcSession(
    accountedTransport(
      serverSide,
      limits,
      (refusal) => new Error(refusal),
      pool
    ),
    main
  );
  return {
    ended,
    server,
    send: (message: unknown): void => {
      toServer.deliver(JSON.stringify(message));
    },
    answer: async (id: number): Promise<unknown> =>
      // oxlint-disable-next-line promise/avoid-new -- answers arrive as messages
      await new Promise((resolve) => {
        waiting.set(id, resolve);
      }),
  };
};

describe("answers held across sessions sharing one pool", () => {
  it("ends the session whose answer takes the pool past its limit, and no other", async () => {
    const pool = heldPool(4 * 1024 * 1024);
    const connections = [1, 2, 3, 4, 5].map(() => {
      const connection = rawConnect(new Files(), pool);
      return { ...connection, peer: hoard(connection) };
    });
    // In turn, each pulls a large answer and never releases it, until one
    // answer would take the pool past its limit: that one isn't sent.
    const answers: unknown[] = [];
    for (const connection of connections) {
      // oxlint-disable-next-line no-await-in-loop -- in turn, so the one that crosses is known
      const answer = await connection.peer.call("source");
      answers.push(answer === "ended" ? answer : "answered");
    }
    const reasons = connections.map(({ ended: { reason } }) => reason);
    expect(reasons.filter((reason) => reason === "isolate")).toHaveLength(1);
    expect(answers.at(-1)).toBe("ended");
    expect(pool.held).toBeLessThanOrEqual(pool.limit);

    // The others still answer.
    const pongs = await Promise.all(
      connections
        .filter(({ ended: { reason } }) => reason === undefined)
        .map(async (connection) => await connection.peer.call("ping"))
    );
    expect(pongs.length).toBeGreaterThan(0);
    expect(pongs.every((pong) => pong === "pong")).toBeTruthy();
  });
});

class Subscription extends RpcTarget {
  // oxlint-disable-next-line class-methods-use-this
  stop(): string {
    return "stopped";
  }
}

class Watcher extends RpcTarget {
  readonly #shared = new Subscription();

  // oxlint-disable-next-line class-methods-use-this
  watch(): Subscription {
    return new Subscription();
  }

  // The same stub handed out twice: Cap'n Web counts it twice.
  twice(): Subscription[] {
    return [this.#shared, this.#shared];
  }
}

interface WatcherApi {
  watch: () => Subscription;
  twice: () => Subscription[];
}

describe("our stubs as the peer subscribes and lets go", () => {
  it("serves thousands of subscriptions released in turn, and a stub handed out twice", async () => {
    const { client, ended } = connect<WatcherApi>(
      new Watcher(),
      heldPool(limits.maxSessionBytes)
    );
    for (let round = 0; round < 2000; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one subscription at a time, as a page opens and closes one
      const subscription = await client.watch();
      subscription[Symbol.dispose]();
    }
    const pair = await client.twice();
    for (const stub of pair) {
      stub[Symbol.dispose]();
    }
    const last = await client.watch();
    await expect(last.stop()).resolves.toBe("stopped");
    expect(ended.reason).toBeUndefined();
  });
});

describe("receives as one of our own messages is refused", () => {
  it("holds nothing for the receives before, and ends only the one waiting", async () => {
    const incoming = channel();
    const transport = accountedTransport(
      {
        send: () => {
          // Nothing listens: only what we refuse matters here.
        },
        receive: incoming.take,
      },
      limits,
      (refusal) => new Error(`refused: ${refusal}`)
    );
    const received = 1000;
    for (let index = 0; index < received; index += 1) {
      incoming.deliver(JSON.stringify(["push", index]));
      // oxlint-disable-next-line no-await-in-loop -- one message after another
      await transport.receive();
    }
    const heldAfterReceives = transport.endable();
    const waiting = transport.receive();
    const heldWhileWaiting = transport.endable();
    // An answer to the peer's first call holding more than the session
    // may: refused as it's sent, which ends the session.
    transport.send(["resolve", 1, "x".repeat(5 * 1024 * 1024)]);
    await expect(waiting).rejects.toThrow("refused:");
    expect({
      heldAfterReceives,
      heldWhileWaiting,
      heldAfter: transport.endable(),
    }).toStrictEqual({
      heldAfterReceives: 0,
      heldWhileWaiting: 1,
      heldAfter: 0,
    });
  });
});
