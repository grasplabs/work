import { connectErrors } from "@grasp-os/shared/connect";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  addConnection,
  agentFor,
  appFor,
  callAs,
  capabilityFor,
  outcome,
  serverUrl,
} from "./connect.ts";
import type { Call } from "./connect.ts";
import { fakeMcpServer } from "./mcp-server.ts";
import { claimedAgo } from "./tool-calls.ts";

// A side effect happens once per idempotency key, however often the call is
// repeated, retried or replayed. Keys are chosen by App and agent code, so
// a key only ever reaches its own subject's result for the same action,
// connection and input.

let sent = 0;
/** What `mail.forward` answers its next calls with: an error, or its result. */
let forwardError: Record<string, unknown> | undefined;
/** An error `mail.forward` answers with as a text block, in its place. */
let forwardText: string | undefined;
/** Whether that error carries an image after its text block. */
let forwardImage = false;
/** Holds `mail.archive` until the test lets it finish. */
let archiveDone: Promise<unknown> = Promise.resolve();

const server = fakeMcpServer(serverUrl, [
  {
    name: "mail.send",
    run: ({ to }) => {
      sent += 1;
      return { output: { messageId: `sent-${sent}`, to } };
    },
  },
  {
    name: "mail.forward",
    run: () => {
      if (forwardText !== undefined) {
        return {
          output: {},
          content: [
            { type: "text", text: forwardText },
            ...(forwardImage
              ? [
                  {
                    type: "image" as const,
                    data: "aGVsbG8=",
                    mimeType: "image/png",
                  },
                ]
              : []),
          ],
          isError: true,
        };
      }
      return forwardError === undefined
        ? { output: { forwarded: true } }
        : { output: forwardError, isError: true };
    },
  },
  {
    name: "mail.bounce",
    // Says it did nothing, as only a native connector is believed.
    run: () => ({
      output: { error: "Rate limited" },
      isError: true,
      notPerformed: true,
    }),
  },
  {
    name: "mail.unsure",
    // Says it can't tell whether it acted.
    run: () => ({
      output: { error: "Gateway timeout" },
      isError: true,
      outcomeUnknown: true,
    }),
  },
  {
    name: "mail.mixed",
    // Says both: that it did nothing, and that its outcome is unknown.
    run: () => ({
      output: { error: "Unsure" },
      isError: true,
      notPerformed: true,
      outcomeUnknown: true,
    }),
  },
  {
    name: "mail.archive",
    run: async () => {
      await archiveDone;
      return { output: { archived: true } };
    },
  },
  {
    name: "mail.draft",
    run: () => ({ output: { draftId: "draft-1" } }),
  },
  {
    name: "mail.export",
    run: () => ({ output: { text: "x".repeat(200 * 1024) } }),
  },
]);

const anna = agentFor("user-anna");

const send = (connectionId: string, idempotencyKey?: string): Call => ({
  connectionId,
  action: "mail.send",
  input: { to: "ben@acme.test" },
  idempotencyKey,
});

describe("a side effect", () => {
  it("is refused without an idempotency key, before anything is sent", async () => {
    const connectionId = await addConnection();
    await expect(outcome(callAs(anna, send(connectionId)))).resolves.toBe(
      "connect.idempotency_key_required"
    );
    expect(server.ran).toStrictEqual([]);
  });

  it("repeated with its key returns the first result without calling out", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    const first = await callAs(anna, call);
    const requestsBefore = server.requests;
    const repeat = await callAs(anna, call);
    expect(repeat).toStrictEqual(first);
    expect(server.ran).toHaveLength(1);
    // Not even a look at the server's tools.
    expect(server.requests).toBe(requestsBefore);
  });

  it("replayed with the same capability returns the first result", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    const capability = await capabilityFor(anna, call);
    const first = await exports.default.call({ ...call, capability });
    const replayed = await exports.default.call({ ...call, capability });
    expect(replayed).toStrictEqual(first);
    expect(server.ran).toHaveLength(1);
  });

  it("with another subject's key runs as its own call and never sees theirs", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "shared-key");
    const subjects = [
      anna,
      agentFor("user-anna", "agent-other"),
      appFor("user-anna", "agent-chat"),
    ];
    const results = await Promise.all(
      subjects.map(async (subject) => await callAs(subject, call))
    );
    expect(new Set(results.map((result) => result.output)).size).toBe(3);
    expect(server.ran).toHaveLength(3);
  });

  it("for another person, with the same key and input, runs as their own call", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    const forAnna = await callAs(anna, call);
    const forBen = await callAs(agentFor("user-ben"), call);
    expect(forBen.output).not.toBe(forAnna.output);
    expect(server.ran).toHaveLength(2);
  });

  it("with a key used for another action or connection runs as its own call", async () => {
    const connectionId = await addConnection();
    const otherConnection = await addConnection();
    await callAs(anna, send(connectionId, "key-1"));
    const draft = await callAs(anna, {
      connectionId,
      action: "mail.draft",
      input: { to: "ben@acme.test" },
      idempotencyKey: "key-1",
    });
    const elsewhere = await callAs(anna, send(otherConnection, "key-1"));
    expect(JSON.parse(draft.output)).toStrictEqual({ draftId: "draft-1" });
    expect(JSON.parse(elsewhere.output)).toHaveProperty("to", "ben@acme.test");
    expect(server.ran.map(({ tool }) => tool)).toStrictEqual([
      "mail.send",
      "mail.draft",
      "mail.send",
    ]);
  });

  it("is refused when its key was used for a different input", async () => {
    const connectionId = await addConnection();
    await callAs(anna, send(connectionId, "key-1"));
    const other = {
      ...send(connectionId, "key-1"),
      input: { to: "ceo@acme.test" },
    };
    await expect(outcome(callAs(anna, other))).resolves.toBe(
      "connect.idempotency_conflict"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("of a remote server, its outcome unknown, is never recovered, and its server never gets an effect key", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    server.network = "drop";
    await outcome(callAs(anna, call));
    // Long past the claim window, still within the horizon.
    await claimedAgo({ id: connectionId });
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect({ ran: server.ran.length, meta: server.callMeta }).toStrictEqual({
      ran: 1,
      meta: [undefined],
    });
  });

  it("of a remote server, its outcome unknown, doesn't hold a run for its person to resolve: its error is the step's", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-2:send");
    server.network = "drop";
    let details: unknown;
    try {
      await callAs(anna, call);
    } catch (error) {
      details =
        error instanceof Error ? Reflect.get(error, "details") : undefined;
    }
    expect({
      details: details ?? null,
      pending: await exports.default.anyPending({
        onBehalfOf: anna.onBehalfOf,
        idempotencyKey: "run-2:send",
      }),
    }).toStrictEqual({ details: null, pending: false });
  });

  it("that may have run before its answer was lost is never sent again", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    server.network = "drop";
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("that the server turned away before its key was taken can be retried with it", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    // A key or session the server refuses is refused on the look at its
    // tools, before connect takes the call's key.
    server.refuseList = true;
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.server_unavailable"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe("ok");
    expect(server.ran).toHaveLength(1);
  });

  it("that a remote server answered 401 to the call itself is never sent again", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    // It may be the provider's refusal of a later request, passed on after
    // the tool's first one went through.
    server.network = "unauthorised";
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    const requestsBefore = server.requests;
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.requests).toBe(requestsBefore);
  });

  it("that a remote server answered 429 is never sent again", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    // A server of its own making may send its provider's 429 after a
    // first write: its outcome is unknown.
    server.network = "rate-limited";
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    const requestsBefore = server.requests;
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.requests).toBe(requestsBefore);
  });

  it("that a remote server's tool says it didn't do is never sent again", async () => {
    const connectionId = await addConnection();
    const call = {
      connectionId,
      action: "mail.bounce",
      input: {},
      idempotencyKey: "run-1:bounce",
    };
    // A tool we don't review could say so after acting: its word frees no
    // key, and its error, like any of a Composio tool's, is unknown.
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("that a remote server's tool says is of unknown outcome spends its key, its error kept as no answer", async () => {
    const connectionId = await addConnection();
    const call = {
      connectionId,
      action: "mail.unsure",
      input: {},
      idempotencyKey: "run-1:unsure",
    };
    // Believed of any server: it can only stop a repeat.
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("whose result says both that it did nothing and that its outcome is unknown keeps its key spent", async () => {
    const connectionId = await addConnection();
    const call = {
      connectionId,
      action: "mail.mixed",
      input: {},
      idempotencyKey: "run-1:mixed",
    };
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("that ran, then drew a JSON-RPC error, is never sent again", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    // A tool handler may throw "invalid params" after it has written.
    server.network = "invalid-params";
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("that a remote server says it has no method for is never sent again", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    // Its word, like a 401's, proves nothing once the call went out.
    server.network = "no-method";
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    const requestsBefore = server.requests;
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.requests).toBe(requestsBefore);
  });

  it("with an answer too large to keep returns it once, and never runs again", async () => {
    const connectionId = await addConnection();
    const call = {
      connectionId,
      action: "mail.export",
      input: {},
      idempotencyKey: "run-1:export",
    };
    const first = await callAs(anna, call);
    expect(first.output.length).toBeGreaterThan(200 * 1024);
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.answer_not_kept"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("past retention is refused, never run again", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    await callAs(anna, call);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
      await expect(outcome(callAs(anna, call))).resolves.toBe(
        "connect.answer_not_kept"
      );
      // Another call's claim drops the expired answer; the key stays used.
      await callAs(anna, send(connectionId, "run-2:send"));
      await expect(outcome(callAs(anna, call))).resolves.toBe(
        "connect.answer_not_kept"
      );
    } finally {
      vi.useRealTimers();
    }
    expect(server.ran).toHaveLength(2);
  });

  // Composio's answer carries no provider status of its own: a provider's
  // 5xx or timeout after it acted reads like a refusal of the input, and a
  // status a toolkit puts in its data proves nothing.
  it.each([
    ["a provider's server error", { error: "502 Bad Gateway" }],
    ["a timeout", { error: "The request timed out" }],
    ["a dropped connection", { error: "Connection reset by peer" }],
    [
      "a refusal it says the provider gave",
      { successful: false, error: "Invalid recipient", data: { status: 400 } },
    ],
    ["nothing it can read", { unexpected: true }],
  ])(
    "that a Composio tool answered with %s is of unknown outcome, never sent again",
    async (_kind, error) => {
      const connectionId = await addConnection();
      const call = {
        connectionId,
        action: "mail.forward",
        input: {},
        idempotencyKey: "run-1:forward",
      };
      forwardError = error;
      try {
        await expect(outcome(callAs(anna, call))).resolves.toBe(
          "connect.outcome_unknown"
        );
        // Even once it would go through, the key stays spent.
        forwardError = undefined;
        const requestsBefore = server.requests;
        await expect(outcome(callAs(anna, call))).resolves.toBe(
          "connect.outcome_unknown"
        );
        expect(server.requests).toBe(requestsBefore);
      } finally {
        forwardError = undefined;
      }
      expect(server.ran).toHaveLength(1);
    }
  );

  it("on a Composio tool the admin marked read-only keeps its error as the failure, on the read path", async () => {
    const connectionId = await addConnection({
      tools: JSON.stringify([{ name: "mail.forward", read: true }]),
    });
    const call = {
      connectionId,
      action: "mail.forward",
      input: {},
      idempotencyKey: "run-1:forward",
    };
    forwardError = { error: "Not found" };
    try {
      const failed = await callAs(anna, call).catch((error: unknown) => error);
      expect({
        code: connectErrors.codeOf(failed),
        details:
          failed instanceof Error && "details" in failed
            ? failed.details
            : undefined,
      }).toStrictEqual({
        code: "connect.action_failed",
        details: { output: JSON.stringify({ error: "Not found" }) },
      });
    } finally {
      forwardError = undefined;
    }
    // A read keeps no answer under a key: it can't have acted, so it runs.
    await expect(outcome(callAs(anna, call))).resolves.toBe("ok");
    expect(server.ran).toHaveLength(2);
  });

  it("whose Composio tool answered with an error logs what it said, redacted and cut short, for the call", async () => {
    const connectionId = await addConnection();
    const call = {
      connectionId,
      action: "mail.forward",
      input: {},
      idempotencyKey: "run-1:forward",
    };
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    forwardError = {
      error: `Upstream refused: Authorization: ${secret}`,
      detail: "x".repeat(5000),
    };
    const warn = vi.spyOn(console, "warn");
    try {
      await expect(outcome(callAs(anna, call))).resolves.toBe(
        "connect.outcome_unknown"
      );
    } finally {
      forwardError = undefined;
    }
    const logged = warn.mock.calls
      .map(([entry]: unknown[]) => entry)
      .find(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" &&
          entry !== null &&
          "event" in entry &&
          entry.event === "connect.composio_error_unknown"
      );
    const text = typeof logged?.error === "string" ? logged.error : "";
    expect({
      callId: typeof logged?.callId,
      action: logged?.action,
      said: text.includes("Upstream refused"),
      redacted: !text.includes("abcdefghijklmnop"),
      bounded: text.length <= 501,
    }).toStrictEqual({
      callId: "string",
      action: "mail.forward",
      said: true,
      redacted: true,
      bounded: true,
    });
  });

  // A text block's JSON is quoted once more in the output connect keeps
  // (`\"password\"`): what is logged is redacted as the server sent it.
  it.each([
    ["a password", JSON.stringify({ password: "hunter2" }), "hunter2"],
    [
      "an access token",
      JSON.stringify({ access_token: "ya29.a0AfH6SMBxyz" }),
      "ya29.a0AfH6SMBxyz",
    ],
    [
      "a bearer token",
      "Request failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
      "abcdefghijklmnopqrstuvwxyz0123",
    ],
  ])(
    "whose Composio tool answered with %s in a text block logs it redacted",
    async (_kind, text, secret) => {
      const connectionId = await addConnection();
      const warn = vi.spyOn(console, "warn");
      forwardText = text;
      try {
        await expect(
          outcome(
            callAs(anna, {
              connectionId,
              action: "mail.forward",
              input: {},
              idempotencyKey: "run-1:forward",
            })
          )
        ).resolves.toBe("connect.outcome_unknown");
      } finally {
        forwardText = undefined;
      }
      const logged = warn.mock.calls
        .map(([entry]: unknown[]) => entry)
        .find(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" &&
            entry !== null &&
            "event" in entry &&
            entry.event === "connect.composio_error_unknown"
        );
      expect({
        logged: typeof logged?.error,
        leaked: JSON.stringify(logged).includes(secret),
        redacted: JSON.stringify(logged).includes("[redacted]"),
      }).toStrictEqual({ logged: "string", leaked: false, redacted: true });
    }
  );

  it("whose Composio tool answered with text and an image logs the text, redacted, and notes the image", async () => {
    const connectionId = await addConnection();
    const warn = vi.spyOn(console, "warn");
    forwardText = "Upload refused: password=hunter2 for ann";
    forwardImage = true;
    try {
      await expect(
        outcome(
          callAs(anna, {
            connectionId,
            action: "mail.forward",
            input: {},
            idempotencyKey: "run-1:forward",
          })
        )
      ).resolves.toBe("connect.outcome_unknown");
    } finally {
      forwardText = undefined;
      forwardImage = false;
    }
    const logged = warn.mock.calls
      .map(([entry]: unknown[]) => entry)
      .find(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" &&
          entry !== null &&
          "event" in entry &&
          entry.event === "connect.composio_error_unknown"
      );
    expect(logged?.error).toBe(
      "Upload refused: password=[redacted] for ann\n(content other than text)"
    );
  });

  it("running at the same time as a repeat runs once", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    const ends = await Promise.all([
      outcome(callAs(anna, call)),
      outcome(callAs(anna, call)),
    ]);
    expect(ends).toContain("ok");
    expect(
      ends.every((end) => end === "ok" || end === "connect.call_in_progress")
    ).toBeTruthy();
    expect(server.ran).toHaveLength(1);
  });
});

describe("a side effect whose call never came back", () => {
  it("holds its key while it may still be running, then never runs again", async () => {
    const connectionId = await addConnection();
    const call = {
      connectionId,
      action: "mail.archive",
      input: {},
      idempotencyKey: "run-1:archive",
    };
    const { promise, resolve } = Promise.withResolvers<boolean>();
    archiveDone = promise;
    // The first call is out at the server, as when connect died mid-call.
    const first = outcome(callAs(anna, call));
    await vi.waitUntil(() => server.ran.length === 1);
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.call_in_progress"
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      await expect(outcome(callAs(anna, call))).resolves.toBe(
        "connect.outcome_unknown"
      );
    } finally {
      vi.useRealTimers();
      resolve(true);
    }
    await expect(first).resolves.toBe("ok");
    expect(server.ran).toHaveLength(1);
  });
});
