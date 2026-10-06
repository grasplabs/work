import { describe, expect, it } from "vite-plus/test";

import { serverLogsOf } from "../src/server-logs.ts";

// What a tail makes of a batch of trace events: the runtime may hand it
// several calls at once, and each keeps its own first lines.

/** One call of `method` that logged `count` lines, as a trace event has it. */
const call = (method: string, count: number) => ({
  event: { rpcMethod: method },
  logs: Array.from({ length: count }, (_, index) => ({
    timestamp: Date.UTC(2026, 9, 6, 12, 0, index),
    level: "log",
    message: [method, index + 1],
  })),
});

describe("server logs of a tail's batch", () => {
  it("keeps the first twenty lines of each call in one batch", () => {
    const logs = serverLogsOf([call("first", 25), call("second", 30)]);
    const of = (method: string) =>
      logs
        .filter((line) => line.method === method)
        .map(({ message }) => message);
    expect({ first: of("first"), second: of("second") }).toStrictEqual({
      first: Array.from({ length: 20 }, (_, index) => `first ${index + 1}`),
      second: Array.from({ length: 20 }, (_, index) => `second ${index + 1}`),
    });
  });
});
