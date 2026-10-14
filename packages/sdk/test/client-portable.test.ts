import { toBase64Url } from "@grasp-os/shared/encoding";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { clientInternals, GraspClient } from "../src/client-core.ts";
import { GraspError } from "../src/client-error.ts";
import type { Id } from "../src/index.ts";
import { api } from "./notes/.grasp/references.ts";

// A portable host's client (`new GraspClient({ url, getToken })`) against
// the network it reaches core through: where its token goes, and what it
// does when the host has none, can't say, or hands it someone else's.
// Core's own routes are tested end to end in apps/core's
// portable-client.test.ts; here the network answers as core would.

const origin = "https://acme.grasp.example";
const app = "app_0000000000000000000000notes";

/** A token of `sub`'s, as core's are shaped; the client only reads `sub`. */
const tokenOf = (sub: string): string =>
  ["e30", JSON.stringify({ sub, app }), "c2ln"]
    .map((part, index) =>
      index === 1 ? toBase64Url(new TextEncoder().encode(part)) : part
    )
    .join(".");

/** The function a request names. */
const contractIdPattern = /"contractId":"(?<contractId>[^"]+)"/u;

/** A host with nobody signed in. */
const noToken = async (): Promise<string | null> => await Promise.resolve(null);

/** What the network saw of one call. */
interface Seen {
  url: string;
  authorization: string | null;
  credentials: unknown;
  redirect: unknown;
  body: string;
}

/**
 * The host's network: answers each call as `answer` says, with core's
 * `{ result }`; `answer` may throw to lose the answer.
 */
const network = (answer: (seen: Seen) => Promise<unknown>) => {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string, init: RequestInit): Promise<Response> => {
      const headers = new Headers(init.headers);
      const call = {
        url: input,
        authorization: headers.get("authorization"),
        credentials: Reflect.get(init, "credentials"),
        redirect: init.redirect,
        body: typeof init.body === "string" ? init.body : "",
      };
      seen.push(call);
      const value = await answer(call);
      return Response.json({ result: { ok: true, value } });
    }
  );
  return seen;
};

/** The structured error `promise` rejected with. */
const failureOf = async (promise: Promise<unknown>): Promise<GraspError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraspError) {
      return error;
    }
    throw error;
  }
  throw new Error("It resolved");
};

const noteId =
  // SAFETY: the form of the store's IDs; nothing here reads it further.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  "01890000-0000-7000-8000-000000000001" as Id<"notes">;

/** Resolves once `ready()` holds, checking between turns of the loop. */
const until = async (ready: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 200 && !ready(); turn += 1) {
    const { promise, resolve } = Promise.withResolvers<null>();
    setTimeout(() => {
      resolve(null);
    }, 1);
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await promise;
  }
  expect(ready()).toBeTruthy();
};

describe("a portable host's client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each call to the App's portable route with the token asked for then, and nothing of the browser's", async () => {
    const tokens = [tokenOf("ann"), tokenOf("ann")];
    let asked = 0;
    const seen = network(async () => await Promise.resolve(null));
    const client = new GraspClient({
      url: `${origin}/`,
      getToken: async () => {
        const token = tokens[asked] ?? null;
        asked += 1;
        return await Promise.resolve(token);
      },
    });
    await client.query(api.notes.get, { id: noteId });
    await client.query(api.notes.get, { id: noteId });
    expect(seen.map(({ body: _body, ...call }) => call)).toStrictEqual(
      tokens.map((token) => ({
        url: `${origin}/api/portable/app-functions/${app}`,
        authorization: `Bearer ${token}`,
        credentials: "omit",
        redirect: "error",
      }))
    );
  });

  it("takes only an https origin, or plain http on this machine", () => {
    const refused = [
      "http://acme.grasp.example",
      `${origin}/api`,
      `${origin}/?next=1`,
      "https://someone@acme.grasp.example",
      "acme.grasp.example",
    ].filter((url) => {
      try {
        // oxlint-disable-next-line no-new -- constructing is what is tested
        new GraspClient({ url, getToken: noToken });
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toHaveLength(5);
    expect(
      () => new GraspClient({ url: "http://localhost:8787", getToken: noToken })
    ).not.toThrow();
  });

  it("sends nothing without a token and clears what it held; a host that fails to say clears nothing", async () => {
    let token: string | null = tokenOf("ann");
    let failing = false;
    const seen = network(async () => await Promise.resolve({ title: "Ann's" }));
    const client = new GraspClient({
      url: origin,
      getToken: async () => {
        await Promise.resolve();
        if (failing) {
          throw new Error("The host's sign-in is down.");
        }
        return token;
      },
    });
    const internals = clientInternals(client);
    const entry = internals.entry(api.notes.get, { id: noteId });
    const stop = internals.subscribe(entry, () => {});
    await until(() => entry.snapshot.value !== undefined);

    failing = true;
    const unavailable = await failureOf(
      client.mutation(api.notes.create, { title: "Later" })
    );
    failing = false;
    token = null;
    const signedOut = await failureOf(
      client.mutation(api.notes.create, { title: "Later" })
    );
    expect({
      unavailable: unavailable.code,
      signedOut: signedOut.code,
      sent: seen.length,
      shown: entry.snapshot,
    }).toStrictEqual({
      unavailable: "auth.token_unavailable",
      signedOut: "auth.unauthenticated",
      sent: 1,
      shown: { value: undefined, error: signedOut },
    });
    stop();
  });

  it("clears one person's data before anything is sent for the next, and reads it again for them", async () => {
    let token = tokenOf("ann");
    const seen = network(
      async ({ authorization }) =>
        await Promise.resolve({
          title:
            authorization === `Bearer ${tokenOf("ann")}` ? "Ann's" : "Bo's",
        })
    );
    const client = new GraspClient({
      url: origin,
      getToken: async () => await Promise.resolve(token),
    });
    const internals = clientInternals(client);
    const entry = internals.entry(api.notes.get, { id: noteId });
    const shown: unknown[] = [];
    const stop = internals.subscribe(entry, () => {
      shown.push(entry.snapshot.value);
    });
    await until(() => entry.snapshot.value !== undefined);

    token = tokenOf("bo");
    const raced = await failureOf(
      client.query(api.notes.list, { pagination: {} })
    );
    await until(() => shown.at(-1) !== undefined);
    expect({
      raced: raced.code,
      shown,
      sentForBo: seen
        .filter(({ authorization }) => authorization === `Bearer ${token}`)
        .map(({ body }) => contractIdPattern.exec(body)?.groups?.contractId),
    }).toStrictEqual({
      raced: "auth.principal_changed",
      // Ann's, then nothing, then Bo's: never Ann's once Bo's token came.
      shown: [{ title: "Ann's" }, undefined, { title: "Bo's" }],
      sentForBo: ["notes.get"],
    });
    stop();
  });

  it.each([
    ["someone else signs in", tokenOf("bo")],
    ["the person signs out", null],
  ])(
    "never sends a save whose answer was lost again once %s: its outcome is the person's to recover",
    async (_change, next) => {
      let token: string | null = tokenOf("ann");
      const seen = network(async ({ authorization }) => {
        await Promise.resolve();
        if (authorization === `Bearer ${tokenOf("ann")}`) {
          // The save reached core; its answer didn't come back.
          token = next;
          throw new TypeError("The connection was reset.");
        }
        return noteId;
      });
      const client = new GraspClient({
        url: origin,
        getToken: async () => await Promise.resolve(token),
      });
      const failure = await failureOf(
        client.mutation(api.notes.create, { title: "Ann's" })
      );
      expect({
        code: failure.code,
        sent: seen.map(({ authorization }) => authorization),
      }).toStrictEqual({
        code: "submission.outcome_unknown",
        sent: [`Bearer ${tokenOf("ann")}`],
      });
      expect(failure.details).toHaveProperty("idempotencyKey");
    }
  );
});
