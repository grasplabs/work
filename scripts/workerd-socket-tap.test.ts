import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { tapSocket } from "./workerd-socket-tap.ts";

/** Sends `chunks` through `socket`, one write each, and reads back what comes. */
const through = async (socket: string, chunks: string[]): Promise<string> => {
  const client = createConnection(socket);
  await once(client, "connect");
  let answered = "";
  client.on("data", (data: Buffer) => {
    answered += data.toString("latin1");
  });
  for (const chunk of chunks) {
    client.write(chunk);
    // oxlint-disable-next-line no-await-in-loop -- each a write of its own
    await sleep(20);
  }
  client.end();
  await once(client, "close");
  return answered;
};

describe("the tap in front of the sandbox supervisor", () => {
  it("passes every byte on both ways, and records each session's owner, even a header split across writes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tap-"));
    // The supervisor's place: answers whatever it reads, as it reads it.
    const upstream = createServer((socket) => {
      socket.pipe(socket);
    }).listen(path.join(dir, "upstream.sock"));
    await once(upstream, "listening");
    const tap = await tapSocket(path.join(dir, "upstream.sock"), dir);
    try {
      const sent = [
        "POST /session HTTP/1.1\r\nhost: sandbox\r\nx-grasp-sandbox-ow",
        "ner: app-1\r\ncontent-length: 2\r\n\r\n{}",
        "POST /session HTTP/1.1\r\nX-Grasp-Sandbox-Owner: platform:builder\r\n\r\n",
      ];

      const answered = await through(tap.socket, sent);

      expect({
        answered,
        owners: [...tap.owners()].toSorted(),
      }).toStrictEqual({
        answered: sent.join(""),
        owners: ["app-1", "platform:builder"],
      });
    } finally {
      await tap.close();
      upstream.close();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
