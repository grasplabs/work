import { appIdSchema } from "@grasp-os/shared/ids";
import type { QuerySnapshotPush } from "@grasp-os/shared/pages";
import { RpcStub } from "capnweb";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { QuerySubscriptions } from "../src/query-subscriptions.ts";
import type { Reader } from "../src/query-subscriptions.ts";

// The gate every push of a live query passes (query-subscriptions.ts), with
// who reads injected: a session reading that changes while the gate reads
// the person's role must never let a push out under the older one. Here the
// reading narrows (a role taken away) while the gate looks at the access,
// as a reading that ran out and was read again would.

/** Someone the queries are read for, with the roles they read under. */
interface Person extends Reader {
  readonly name: string;
  readonly roles: string;
}

/** Which of the gate's looks is the one before the first push. */
const pushLook = 3;

const wide: Person = { userId: "person-1", name: "wide", roles: "builder" };
const narrow: Person = { userId: "person-1", name: "narrow", roles: "user" };

describe("a live query's gate", () => {
  it("passes a push only under the newest reading of who reads: one read under rights narrowed meanwhile is read again first", async () => {
    let reading = wide;
    let looks = 0;
    const queries = new QuerySubscriptions<Person>(env, {
      check: async () => await Promise.resolve(reading),
      // The rights narrow while the gate looks for the push itself (the
      // third look: the read is passed before and after it reads): the
      // next reading is the narrower one.
      access: async () => {
        looks += 1;
        if (looks === pushLook) {
          reading = narrow;
        }
        return await Promise.resolve("open" as const);
      },
      roles: async (by) => await Promise.resolve(by.roles),
      admit: async () => await Promise.resolve(true),
      revocable: false,
      // Looked at before every push, never kept: what each gate reads.
      uncached: () => true,
      forget: () => {
        // Each reading is the test's own.
      },
      evaluate: async (by) =>
        await Promise.resolve({
          result: { ok: true as const, value: JSON.stringify(by.name) },
          reads: undefined,
        }),
    });
    const pushed: unknown[] = [];
    // The page's callback as core holds it: a stub.
    const onSnapshot = new RpcStub((push: QuerySnapshotPush) => {
      pushed.push(push.result);
    });

    queries.subscribe(
      wide,
      appIdSchema.parse(crypto.randomUUID()),
      undefined,
      JSON.stringify({ reference: { name: "q", kind: "query" }, args: {} }),
      onSnapshot
    );

    await vi.waitFor(() => {
      expect(pushed.length).toBeGreaterThan(0);
    });
    expect(pushed).toStrictEqual(
      pushed.map(() => ({ ok: true, value: JSON.stringify("narrow") }))
    );
  });
});
