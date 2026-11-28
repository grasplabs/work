import { authErrors } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { checkedInCall, noteCall } from "../src/call-context.ts";
import { PageFrameRpc } from "../src/pages-rpc.ts";
import { SessionRpc } from "../src/session-rpc.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInWithRole, whoami } from "./sign-in.ts";
import { callWaitMs, targetMethods } from "./target-methods.ts";

// Every call a connection carries checks the session again as it answers
// (call-context.ts): the one place it happens, around every method of
// every target a browser reaches. These start from the way it can fail: a
// method that reads the session and answers without passing that place
// (its own way to the session, a target outside the base), which would
// answer someone whose session ended while it ran.

const idp = mockIdp();

/** A refusal as the check after the call makes it: the session ended meanwhile. */
const endedMeanwhile = () => authErrors.create("auth.unauthenticated");

/**
 * A connection's check as rpc.ts makes it, for `person`: it registers the
 * check after the call, which refuses (the session ended while the call
 * ran), and counts its readings.
 */
const endingCheck = (person: Identity) => {
  const state = { reads: 0 };
  const check = async (): Promise<Identity> => {
    state.reads += 1;
    checkedInCall(async () => {
      await Promise.resolve();
      throw endedMeanwhile();
    });
    return await Promise.resolve(person);
  };
  return { check, state };
};

/**
 * Calls each method `connect` hands out, each on a connection of its own,
 * and names those that read the session and still answered.
 */
const answeredAfterTheEnd = async (
  connect: (check: () => Promise<Identity>) => object,
  path: string,
  person: Identity
): Promise<{ called: number; answered: string[] }> => {
  const names = targetMethods(
    connect(async () => await Promise.resolve(person)),
    path
  ).map(({ name }) => name);
  const answered: string[] = [];
  for (const name of names) {
    const { check, state } = endingCheck(person);
    const call = targetMethods(connect(check), path).find(
      (method) => method.name === name
    )?.call;
    // oxlint-disable-next-line no-await-in-loop -- one call at a time
    const settled = await Promise.race([
      outcome(Promise.resolve().then(() => call?.())),
      scheduler.wait(callWaitMs).then(() => "waiting"),
    ]);
    if (state.reads > 0 && settled === "ok") {
      answered.push(name);
    }
  }
  return { called: names.length, answered };
};

describe("a call over a connection", () => {
  it("answers nobody whose session ended while it ran: refused as its answer goes back", async () => {
    let ended = false;
    const answered = noteCall(
      { target: {}, method: "read", args: [], params: [] },
      async () => {
        checkedInCall(async () => {
          await Promise.resolve();
          if (ended) {
            throw endedMeanwhile();
          }
        });
        // The session ends, with nothing told, while the call runs.
        ended = true;
        return await Promise.resolve("their data");
      }
    );

    await expect(outcome(Promise.resolve(answered))).resolves.toBe(
      "auth.unauthenticated"
    );
  });

  it("of any method of any namespace, or of a page's frame, never answers once its session ended while it ran", async () => {
    const { session: cookie } = await signedInWithRole(idp, "admin");
    const identity = await whoami(cookie);

    const session = await answeredAfterTheEnd(
      (check) =>
        new SessionRpc(
          env,
          check,
          crypto.randomUUID(),
          new AbortController().signal
        ),
      "session",
      identity
    );
    const frame = await answeredAfterTheEnd(
      (check) =>
        new PageFrameRpc({
          env,
          check,
          userId: identity.userId,
          app: appIdSchema.parse(crypto.randomUUID()),
          lease: undefined,
          // SAFETY: never reached: the App doesn't exist, so nothing
          // follows a query.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          queries: {} as never,
        }),
      "frame",
      identity
    );

    expect(session.called).toBeGreaterThan(100);
    expect(frame.called).toBeGreaterThan(5);
    expect({ session: session.answered, frame: frame.answered }).toStrictEqual({
      session: [],
      frame: [],
    });
  }, 900_000);
});
