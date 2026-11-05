import { describe, expect, it } from "vite-plus/test";

import { untilAnswered, waitingOnNow } from "./open-sockets.ts";

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
});
