import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { heldModule } from "./held-module-gate.ts";
import { untilAnswered, waitingOnNow } from "./open-sockets.ts";

const heldModuleLoading = /^module still loading: \S*\/held-module\.ts$/u;

// What a test that timed out is said to wait on (start-each-file.ts) is
// its own: a request an earlier test left unanswered, which may never
// settle, is forgotten once that test ends. In order: the second test
// reads what the first left.

describe("what a test waits on", () => {
  it("names a request it sent that is still unanswered", () => {
    void untilAnswered(
      "POST /api/auth/sign-in/sso",
      Promise.withResolvers<never>().promise
    );

    expect(waitingOnNow()).toStrictEqual([
      "unanswered: POST /api/auth/sign-in/sso, sent 0s ago",
    ]);
  });

  it("leaves out what an earlier test left unanswered", () => {
    void untilAnswered("GET /rpc", Promise.withResolvers<never>().promise);

    expect(waitingOnNow()).toStrictEqual(["unanswered: GET /rpc, sent 0s ago"]);
  });

  it("names a module still loading, until it has loaded", async () => {
    const loading = import("./held-module.ts");

    await vi.waitFor(() => {
      expect(waitingOnNow()).toStrictEqual([
        expect.stringMatching(heldModuleLoading),
      ]);
    });

    heldModule.resolve("go");
    await loading;

    expect(waitingOnNow()).toStrictEqual([]);
  });

  it("names a D1 statement still running, until it has answered", async () => {
    const running = env.DB.prepare(
      "SELECT  name\n  FROM sqlite_master WHERE name = ?"
    )
      .bind("members")
      .first();

    expect(waitingOnNow()).toStrictEqual([
      "unanswered: D1 first: SELECT name FROM sqlite_master WHERE name = ?, sent 0s ago",
    ]);

    await running;

    expect(waitingOnNow()).toStrictEqual([]);
  });

  it("names a D1 batch still running, by its size and first statement", async () => {
    const running = env.DB.batch([
      env.DB.prepare("SELECT 1"),
      env.DB.prepare("SELECT 2"),
    ]);

    expect(waitingOnNow()).toStrictEqual([
      "unanswered: D1 batch of 2: SELECT 1, sent 0s ago",
    ]);

    await running;

    expect(waitingOnNow()).toStrictEqual([]);
  });
});
