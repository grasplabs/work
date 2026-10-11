import { connectErrors } from "@grasp-os/shared/connect";
import {
  errorPayloadSchema,
  internalErrors,
  requestErrors,
} from "@grasp-os/shared/errors";
import { modelErrors } from "@grasp-os/shared/models";
import { routerSecretHeader } from "@grasp-os/shared/router";
import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { toClientError } from "../src/rpc.ts";
import { closeWhenTestEnds } from "./open-sockets.ts";
import { clientOrigin } from "./sign-in-config.ts";

const openRpc = async (headers: HeadersInit) =>
  await exports.default.fetch("https://core/rpc", { headers });

/** Signed out, as an unauthenticated client reaches `CoreRpc`. */
const signedOut: HeadersInit = {
  Upgrade: "websocket",
  Origin: clientOrigin,
  [routerSecretHeader]: env.ROUTER_SECRET,
};

/**
 * A raw connection to `/rpc` that speaks Cap'n Web's messages by hand, as a
 * page someone changed can: `push` sends an expression and gives the export
 * ID it gets (1, 2, ... in order), `pull` asks what one settled as, and
 * `closed` resolves when core ends the session.
 */
const rawRpc = async (headers: HeadersInit) => {
  const response = await openRpc(headers);
  const socket = response.webSocket;
  if (!socket) {
    throw new Error(`Expected a WebSocket, got ${response.status}`);
  }
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  const settled = new Map<number, (value: unknown) => void>();
  socket.addEventListener("close", (event) => {
    closed.resolve({ code: event.code, reason: event.reason });
  });
  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (
      Array.isArray(message) &&
      message[0] === "resolve" &&
      typeof message[1] === "number"
    ) {
      settled.get(message[1])?.(message[2]);
    }
  });
  socket.accept();
  let pushed = 0;
  const send = (message: unknown): void => {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The session has closed: nothing more to send over it.
    }
  };
  return {
    socket,
    closed: closed.promise,
    push: (expression: unknown): number => {
      send(["push", expression]);
      pushed += 1;
      return pushed;
    },
    pull: async (id: number): Promise<unknown> => {
      const answer = Promise.withResolvers<unknown>();
      settled.set(id, answer.resolve);
      send(["pull", id]);
      return await answer.promise;
    },
    send,
  };
};

/** The reference-expansion probe from GRA-424: a chain of `count` pushes. */
const sendExpansionProbe = (
  connection: Awaited<ReturnType<typeof rawRpc>>,
  count: number
): void => {
  connection.push("x");
  for (let level = 1; level <= count; level += 1) {
    connection.push([
      [
        ["pipeline", level],
        ["pipeline", level],
      ],
    ]);
  }
};

describe("the memory a session spends expanding references", () => {
  it("ends the probe signed out, and other sessions keep working", async () => {
    const probe = await rawRpc(signedOut);
    sendExpansionProbe(probe, 16);
    // The reference to the last push, as a call argument, is what the
    // unbounded session would deep-copy before the method runs.
    probe.push(["pipeline", 0, ["ping"], [["pipeline", 17]]]);

    const end = await probe.closed;
    expect(end.code).toBe(3000);
    expect(end.reason).toContain("expand");

    // The isolate survived: a fresh session still answers.
    const other = await rawRpc(signedOut);
    const pong = await other.pull(other.push(["pipeline", 0, ["ping"], []]));
    expect(pong).toBe("pong");
    other.socket.close();
  });

  it("ends the chain of pushes with no call at all", async () => {
    const probe = await rawRpc(signedOut);
    sendExpansionProbe(probe, 16);

    const end = await probe.closed;
    expect(end.code).toBe(3000);
  });

  it("passes a large but legal value", async () => {
    const connection = await rawRpc(signedOut);
    // A megabyte of flat data, far under one message's budget: pushed, then
    // a call that still answers proves the session stayed open.
    connection.push("a".repeat(1024 * 1024));
    const pong = await connection.pull(
      connection.push(["pipeline", 0, ["ping"], []])
    );
    expect(pong).toBe("pong");
    connection.socket.close();
  });

  it("can't be fooled by releasing an export with a zero count", async () => {
    const probe = await rawRpc(signedOut);
    // Build one costly export, then release it with count 0: Cap'n Web keeps
    // it alive, so the session must not treat it as freed. The release is a
    // shape Cap'n Web wouldn't accept, so the session ends.
    probe.send(["push", "x"]);
    probe.send([
      "push",
      [
        [
          ["pipeline", 1],
          ["pipeline", 1],
        ],
      ],
    ]);
    probe.send(["release", 2, 0]);

    const end = await probe.closed;
    expect(end.code).toBe(3000);
  });

  it("ends a message that would parse into millions of tiny nodes", async () => {
    const flood = await rawRpc(signedOut);
    // A single message of nothing but tiny inline nodes: refused from its
    // text before it is parsed, so the parse can't exhaust the isolate.
    flood.push([[Array.from({ length: 400_000 }, () => 0)]]);

    const end = await flood.closed;
    expect(end.code).toBe(3000);

    const other = await rawRpc(signedOut);
    const pong = await other.pull(other.push(["pipeline", 0, ["ping"], []]));
    expect(pong).toBe("pong");
    other.socket.close();
  });

  it("ends a bomb grown from a value the peer would answer itself", async () => {
    const probe = await rawRpc(signedOut);
    // Export 1 holds a stub the peer gave us, and export 2 is a call through
    // it: the peer answers that call with a value of any size, so a copy of
    // export 2 is refused, and the doubling chain built on it can't grow.
    probe.send(["push", ["export", 100]]);
    probe.send(["push", ["pipeline", 1, ["get"], []]]);
    probe.send([
      "push",
      [
        [
          ["pipeline", 2],
          ["pipeline", 2],
        ],
      ],
    ]);

    const end = await probe.closed;
    expect(end.code).toBe(3000);
  });

  it("keeps a session open that passes its own callback and uses the answer", async () => {
    const connection = await rawRpc(signedOut);
    // A call whose argument is the page's own stub, as `watch(callback)` is.
    // The answer is ours, so the page may pull it, call through it and pass
    // it on without the session ending. (`ping` takes no callback; the call
    // is refused as a value calls don't take, and the session goes on.)
    connection.send(["push", ["pipeline", 0, ["ping"], [["export", -1]]]]);
    connection.send(["push", ["pipeline", 0, ["ping"], [["pipeline", 1]]]]);
    connection.send(["push", ["pipeline", 0, ["ping"], []]]);
    const pong = await connection.pull(3);
    expect(pong).toBe("pong");
    connection.socket.close();
  });

  it("keeps serving many streamed answers in one session", async () => {
    const connection = await rawRpc(signedOut);
    // Cap'n Web answers each stream as it arrives and frees it then, and so
    // does the accountant: more streams than may be pending at once, never
    // released, still leave the session open. Each stream takes an export
    // id, so the ping call is the id after the last stream.
    const streams = 10_000;
    for (let i = 0; i < streams; i += 1) {
      connection.send(["stream", "x"]);
    }
    connection.send(["push", ["pipeline", 0, ["ping"], []]]);
    const pong = await connection.pull(streams + 1);
    expect(pong).toBe("pong");
    connection.socket.close();
  });
});

describe("Cap'n Web RPC", () => {
  it("answers ping over a WebSocket", async () => {
    const response = await openRpc({
      Upgrade: "websocket",
      // The deployment's own page, from its sign-in config.
      Origin: clientOrigin,
      [routerSecretHeader]: env.ROUTER_SECRET,
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) {
      throw new Error("Expected a WebSocket");
    }
    socket.accept();
    closeWhenTestEnds(socket);

    const core = newWebSocketRpcSession<CoreApi>(socket);
    try {
      await expect(core.ping()).resolves.toBe("pong");
    } finally {
      core[Symbol.dispose]();
    }
  });

  it("asks for a WebSocket upgrade on a plain request", async () => {
    const response = await openRpc({ [routerSecretHeader]: env.ROUTER_SECRET });
    expect(response.status).toBe(426);
    expect(response.headers.get("Upgrade")).toBe("websocket");
    const error = errorPayloadSchema.parse(await response.json());
    expect(error.code).toBe("request.upgrade_required");
  });

  it("won't open a session without the router secret", async () => {
    const response = await openRpc({ Upgrade: "websocket" });
    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });
});

describe("errors sent to the client", () => {
  it("replaces an unexpected error, keeping only the request ID", () => {
    const cause = new Error("Bucket grasp-internal unreachable");
    const sent = toClientError(cause, "request-1");

    expect(internalErrors.codeOf(sent)).toBe("internal.unexpected");
    expect(sent?.message).not.toContain("grasp-internal");
    expect(sent?.stack).toBeUndefined();
    expect(sent).toMatchObject({ details: { requestId: "request-1" } });
  });

  it("sends an expected error of any family as it is", () => {
    for (const expected of [
      requestErrors.create("request.forbidden"),
      modelErrors.create("model.not_allowed"),
      connectErrors.create("connect.invalid"),
    ]) {
      expect(toClientError(expected, "request-1")).toBeUndefined();
    }
  });
});
