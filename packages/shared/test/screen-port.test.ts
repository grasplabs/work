import { once } from "node:events";

import { describe, expect, it } from "vite-plus/test";

import { screenLimits } from "../src/screen-limits.ts";
import { portTransport } from "../src/screen-port.ts";

// The reading end of a screen's port, with a sender that doesn't wait to
// be heard: what arrives unread is held only up to a number and a size,
// and past that the port closes, over a real `MessageChannel`.

/** A transport on one end of a channel, and how to send from the other. */
const channel = () => {
  const { port1, port2 } = new MessageChannel();
  return {
    transport: portTransport(port1),
    sender: port2,
    send: (message: string): void => {
      port2.postMessage(message);
    },
  };
};

/** Why reading failed, or what was read. */
const read = async (
  transport: ReturnType<typeof portTransport>
): Promise<string> => {
  try {
    return await transport.receive();
  } catch (error) {
    return error instanceof Error ? `failed: ${error.message}` : "failed";
  }
};

const unread = "failed: More arrived on the port than is held unread.";

describe("a screen's port", () => {
  it("hands over what was sent, in order, however much has passed through", async () => {
    const { transport, sender, send } = channel();
    const rounds = 3;
    const sent: string[] = [];
    const got: string[] = [];
    for (let round = 0; round < rounds; round += 1) {
      for (let count = 0; count < screenLimits.portQueue.messages; count += 1) {
        const message = `${round}:${count}:${"x".repeat(1000)}`;
        sent.push(message);
        send(message);
      }
      for (let count = 0; count < screenLimits.portQueue.messages; count += 1) {
        // oxlint-disable-next-line no-await-in-loop -- read in order
        got.push(await read(transport));
      }
    }
    sender.close();

    expect(got).toStrictEqual(sent);
  });

  it("closes once more messages wait unread than it holds", async () => {
    const { transport, sender, send } = channel();
    // The first is read as it comes; the rest wait.
    const first = read(transport);
    for (
      let count = 0;
      count < screenLimits.portQueue.messages + 50;
      count += 1
    ) {
      send(`message ${count}`);
    }
    // The sender's end hears the port close.
    await once(sender, "close");

    expect({ first: await first, next: await read(transport) }).toStrictEqual({
      first: "message 0",
      next: unread,
    });
  });

  it("closes once more characters wait unread than it holds, however few the messages", async () => {
    const { transport, sender, send } = channel();
    const long = "x".repeat(250_000);
    const first = read(transport);
    // One read, then five waiting: 1,250,000 characters.
    for (let count = 0; count < 6; count += 1) {
      send(long);
    }
    await once(sender, "close");

    const read1 = await first;
    expect({
      first: read1.length,
      next: await read(transport),
    }).toStrictEqual({ first: 250_000, next: unread });
  });
});
