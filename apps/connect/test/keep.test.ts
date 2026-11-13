import { describe, expect, it } from "vite-plus/test";

import { addConnection, agentFor, callAs } from "./connect.ts";
import { fakeMcpServer } from "./mcp-server.ts";

// What connect lets core keep of a call as sources in the Brain
// (`ConnectResult.keep`, GRA-1730). The ways it can fail, which these
// start from: a change, a held call or a stored answer replayed is kept;
// a read whose server named no item is kept as if it were one; a toolkit
// whose provider's terms forbid copies is kept.

const url = "https://backend.composio.dev/v3/mcp/server-keep?user_id=grasp";

fakeMcpServer(url, [
  {
    name: "mail.read",
    readOnly: true,
    run: () => ({
      output: { message: { id: "message-1", subject: "Quote" } },
      provenance: ["message-1"],
    }),
  },
  {
    name: "mail.list",
    readOnly: true,
    run: () => ({ output: { messages: [] } }),
  },
  {
    name: "mail.search",
    readOnly: true,
    run: () => ({
      output: { messages: [{ id: "message-2" }] },
      provenance: ["message-2"],
    }),
  },
  {
    name: "mail.send",
    readOnly: false,
    run: () => ({ output: { sent: true }, provenance: ["message-3"] }),
  },
]);

/** A connection to the server above, of `provider`'s toolkit. */
const connection = async (provider = "mail") =>
  await addConnection({
    provider,
    server: url,
    tools: JSON.stringify([
      { name: "mail.read", read: true },
      { name: "mail.list", read: true },
      { name: "mail.search", read: true },
      "mail.send",
    ]),
  });

const chat = agentFor("user-anna", "agent-chat", "interactive");
const run = agentFor("user-anna");

describe("what connect lets core keep of a call", () => {
  it("is a read carried out now whose server named its items", async () => {
    const connectionId = await connection();

    const [named, unnamed] = await Promise.all([
      callAs(chat, { connectionId, action: "mail.read", input: {} }),
      callAs(chat, { connectionId, action: "mail.list", input: {} }),
    ]);

    expect({ named: named.keep, unnamed: unnamed.keep }).toStrictEqual({
      named: true,
      // Known by its toolkit and tool alone: no item of its own.
      unnamed: undefined,
    });
  });

  it("is nothing of a toolkit whose provider's terms forbid copies", async () => {
    const connectionId = await connection("mail_private");

    const read = await callAs(chat, {
      connectionId,
      action: "mail.search",
      input: {},
    });

    expect({ provenance: read.provenance, keep: read.keep }).toStrictEqual({
      provenance: ["message-2"],
      keep: undefined,
    });
  });

  it("is nothing of a change, carried out or replayed, nor of a call held for its person", async () => {
    const connectionId = await connection();
    const send = {
      connectionId,
      action: "mail.send",
      input: {},
      idempotencyKey: `run-${crypto.randomUUID()}:send`,
    };

    const done = await callAs(run, send);
    const replayed = await callAs(run, send);
    const held = await callAs(chat, {
      connectionId,
      action: "mail.send",
      input: {},
    });

    expect(
      [done, replayed, held].map(({ provenance, pending, keep }) => ({
        provenance,
        pending: pending !== undefined,
        keep,
      }))
    ).toStrictEqual([
      { provenance: ["message-3"], pending: false, keep: undefined },
      { provenance: ["message-3"], pending: false, keep: undefined },
      { provenance: [], pending: true, keep: undefined },
    ]);
  });
});
