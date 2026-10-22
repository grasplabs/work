/**
 * A pass-through in front of the sandbox supervisor's Unix socket, for the
 * on-prem smoke run (workerd-smoke.ts): core reaches the supervisor
 * through it, byte for byte, and it records the owner of every session
 * core asks for (`x-grasp-sandbox-owner`, apps/core/src/sandbox-headers.ts).
 * So the run can show App code ran on the sandbox host, as whose, rather
 * than take an answer's word for it. It reads requests only to find that
 * header, and changes nothing either way.
 */
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";

import { sandboxOwnerHeader } from "../apps/core/src/sandbox-headers.ts";

/** The owner header, wherever a request's head carries it. */
const ownerLine = new RegExp(
  `^${sandboxOwnerHeader}:[ \\t]*([^\\r\\n]+)`,
  "gimu"
);

/** How much of the bytes before a chunk is read with it: a header split across two. */
const carriedBytes = 512;

/** A running tap. */
export interface SocketTap {
  /** The socket to hand core in the supervisor's place. */
  socket: string;
  /** Every owner a session was asked for as, so far. */
  owners: () => ReadonlySet<string>;
  close: () => Promise<void>;
}

/** Starts a tap at `dir`/tap.sock that passes everything on to `target`. */
export const tapSocket = async (
  target: string,
  dir: string
): Promise<SocketTap> => {
  const socket = path.join(dir, "tap.sock");
  const owners = new Set<string>();
  const open = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection(target);
    open.add(client);
    open.add(upstream);
    let carried = "";
    client.on("data", (chunk: Buffer) => {
      const text = carried + chunk.toString("latin1");
      for (const [, owner] of text.matchAll(ownerLine)) {
        if (owner !== undefined) {
          owners.add(owner.trim());
        }
      }
      carried = text.slice(-carriedBytes);
    });
    client.pipe(upstream);
    upstream.pipe(client);
    const end = (): void => {
      client.destroy();
      upstream.destroy();
      open.delete(client);
      open.delete(upstream);
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", end);
    upstream.on("error", end);
  });
  server.listen(socket);
  await once(server, "listening");
  return {
    socket,
    owners: () => owners,
    close: async () => {
      for (const each of open) {
        each.destroy();
      }
      server.close();
      await once(server, "close");
    },
  };
};
