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

/**
 * A token of `sub`'s, as core's are shaped; the client reads only `sub`,
 * and `exp` (in seconds) when given. Without one it is asked for again
 * on every call.
 */
const tokenOf = (sub: string, exp?: number): string =>
  [
    "e30",
    JSON.stringify({ sub, app, ...(exp === undefined ? {} : { exp }) }),
    "c2ln",
  ]
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
 * `{ result }` or the response it gives; `answer` may throw to lose the
 * answer.
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
      return value instanceof Response
        ? value
        : Response.json({ result: { ok: true, value } });
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

/** A note ID, as the App's store makes them. */
const idOf = (suffix: number): Id<"notes"> =>
  // SAFETY: the form of the store's IDs; nothing here reads it further.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  `01890000-0000-7000-8000-${String(suffix).padStart(12, "0")}` as Id<"notes">;

const noteId =
  // SAFETY: the form of the store's IDs; nothing here reads it further.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  "01890000-0000-7000-8000-000000000001" as Id<"notes">;

/** An `exp` 40 seconds from now: a token kept for 10 of them. */
const expiry = (): number => Math.floor(Date.now() / 1000) + 40;

/** Core's answer to a read that found nothing. */
const ok = (): Response => Response.json({ result: { ok: true, value: null } });

/** Resolves after the turns of the loop queued now have run. */
const scheduler = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  setTimeout(() => {
    resolve(null);
  }, 1);
  await promise;
};

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
    vi.useRealTimers();
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

  it("never sends a save as the next person when they sign in while it waits for its token", async () => {
    const asked = [Promise.withResolvers<string>()];
    let next = Promise.resolve(tokenOf("ann"));
    const seen = network(async () => await Promise.resolve(noteId));
    const client = new GraspClient({
      url: origin,
      getToken: async () => await next,
    });
    await client.query(api.notes.get, { id: noteId });

    const [waiting] = asked;
    if (waiting === undefined) {
      throw new Error("No request");
    }
    next = waiting.promise;
    const save = failureOf(
      client.mutation(api.notes.create, { title: "Ann's draft" })
    );
    waiting.resolve(tokenOf("bo"));
    const failure = await save;
    expect({
      code: failure.code,
      sent: seen.map(
        ({ authorization, body }) =>
          `${authorization} ${contractIdPattern.exec(body)?.groups?.contractId}`
      ),
    }).toStrictEqual({
      code: "auth.principal_changed",
      sent: [`Bearer ${tokenOf("ann")} notes.get`],
    });
  });

  it("asks the host once for a token it may keep, and again only once core refuses it", async () => {
    const later = Math.floor(Date.now() / 1000) + 300;
    let asked = 0;
    let refuse = false;
    network(async () => {
      await Promise.resolve();
      return refuse
        ? Response.json(
            { code: "auth.unauthenticated", message: "Sign in to continue." },
            { status: 401 }
          )
        : null;
    });
    const client = new GraspClient({
      url: origin,
      getToken: async () => {
        asked += 1;
        return await Promise.resolve(tokenOf("ann", later));
      },
    });
    for (let call = 0; call < 5; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one call after another
      await client.query(api.notes.get, { id: idOf(call) });
    }
    const keptFor = asked;
    refuse = true;
    await failureOf(client.query(api.notes.get, { id: idOf(9) }));
    refuse = false;
    await client.query(api.notes.get, { id: idOf(10) });
    expect({ keptFor, after: asked }).toStrictEqual({ keptFor: 1, after: 2 });
  });

  it("asks again for a token within half a minute of its expiry", async () => {
    const soon = Math.floor(Date.now() / 1000) + 20;
    let asked = 0;
    network(async () => await Promise.resolve(null));
    const client = new GraspClient({
      url: origin,
      getToken: async () => {
        asked += 1;
        return await Promise.resolve(tokenOf("ann", soon));
      },
    });
    await client.query(api.notes.get, { id: idOf(1) });
    await client.query(api.notes.get, { id: idOf(2) });
    expect(asked).toBe(2);
  });

  it("never keeps a token the host answered to a request made before core refused the last", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const requests: PromiseWithResolvers<string>[] = [];
    const answers: PromiseWithResolvers<Response>[] = [];
    const seen = network(async () => {
      const answer = Promise.withResolvers<Response>();
      answers.push(answer);
      return await answer.promise;
    });
    const client = new GraspClient({
      url: origin,
      getToken: async () => {
        const request = Promise.withResolvers<string>();
        requests.push(request);
        return await request.promise;
      },
    });

    // A token kept for 10 seconds, sent with a read whose answer waits.
    const first = failureOf(client.query(api.notes.get, { id: idOf(1) }));
    await until(() => requests.length === 1);
    requests[0]?.resolve(tokenOf("ann", expiry()));
    await until(() => answers.length === 1);
    // Past its keeping: the next call asks the host, which takes a while.
    vi.setSystemTime(Date.now() + 20_000);
    const second = failureOf(client.query(api.notes.list, { pagination: {} }));
    await until(() => requests.length === 2);
    // Core refuses the first token; then the host answers the old request.
    answers[0]?.resolve(
      Response.json(
        { code: "auth.unauthenticated", message: "Sign in to continue." },
        { status: 401 }
      )
    );
    await first;
    const stale = tokenOf("ann-stale", expiry());
    requests[1]?.resolve(stale);
    // The host is asked afresh rather than the stale answer kept, and a
    // call made now waits for that answer.
    await until(() => requests.length === 3);
    const third = client.query(api.notes.get, { id: idOf(3) });
    requests[2]?.resolve(tokenOf("ann", expiry()));
    await until(() => answers.length === 2);
    answers[1]?.resolve(ok());
    await third;
    await second;
    expect(
      seen.map(({ authorization }) => authorization === `Bearer ${stale}`)
    ).toStrictEqual([false, false]);
  });

  it("never sends a key left unknown as the next person, though the resend that found them was refused", async () => {
    let token = tokenOf("ann");
    const seen = network(async ({ authorization }) => {
      await Promise.resolve();
      if (authorization === `Bearer ${tokenOf("ann")}`) {
        // An outcome the host can't tell: the action's key is left unknown
        // (a lost answer would be sent again for its receipt).
        return Response.json({
          result: {
            ok: false,
            error: {
              code: "operation.sandbox_lost",
              message: "The sandbox stopped answering.",
              category: "uncertain",
              retryable: false,
              requestId: "r",
            },
          },
        });
      }
      return 3;
    });
    const client = new GraspClient({
      url: origin,
      getToken: async () => await Promise.resolve(token),
    });
    const lost = await failureOf(client.action(api.notes.tally));
    const { details } = lost;
    const key: unknown =
      typeof details === "object" && details !== null
        ? Reflect.get(details, "idempotencyKey")
        : undefined;
    const keyed = { idempotencyKey: String(key) };
    // Bo signs in: the resend that asks for the token finds him, unsent.
    token = tokenOf("bo");
    const found = await failureOf(client.action(api.notes.tally, {}, keyed));
    const again = await failureOf(client.action(api.notes.tally, {}, keyed));
    expect({
      found: found.code,
      again: again.code,
      sent: seen.map(({ authorization }) => authorization),
    }).toStrictEqual({
      found: "auth.principal_changed",
      again: "auth.principal_changed",
      sent: [`Bearer ${tokenOf("ann")}`],
    });
  });

  it("never joins one person's save to the next person's, however the first one left", async () => {
    let token = tokenOf("ann");
    const held = Promise.withResolvers<null>();
    const seen = network(async ({ body }) => {
      const contract = contractIdPattern.exec(body)?.groups?.contractId;
      if (contract === "notes.create" && token === tokenOf("ann")) {
        await held.promise;
        return noteId;
      }
      if (contract === "notes.get") {
        // Ann signed out: core refuses her token.
        return Response.json(
          { code: "auth.unauthenticated", message: "Sign in to continue." },
          { status: 401 }
        );
      }
      return idOf(2);
    });
    const client = new GraspClient({
      url: origin,
      getToken: async () => await Promise.resolve(token),
    });
    const keyed = { idempotencyKey: "weekly-report" };
    const anns = client.mutation(api.notes.create, { title: "Report" }, keyed);
    await until(() => seen.length === 1);
    await failureOf(client.query(api.notes.get, { id: noteId }));
    token = tokenOf("bo");
    const bos = await client.mutation(
      api.notes.create,
      { title: "Report" },
      keyed
    );
    held.resolve(null);
    expect({
      bos,
      anns: await anns,
      creates: seen
        .filter(({ body }) => body.includes("notes.create"))
        .map(({ authorization }) => authorization),
    }).toStrictEqual({
      bos: idOf(2),
      anns: noteId,
      creates: [`Bearer ${tokenOf("ann")}`, `Bearer ${tokenOf("bo")}`],
    });
  });

  it("joins the same save sent again before its first token arrived", async () => {
    const asked = Promise.withResolvers<string>();
    const held = Promise.withResolvers<null>();
    const seen = network(async () => {
      await held.promise;
      return noteId;
    });
    const client = new GraspClient({
      url: origin,
      getToken: async () => await asked.promise,
    });
    const keyed = { idempotencyKey: "first-save" };
    const first = client.mutation(api.notes.create, { title: "Once" }, keyed);
    asked.resolve(tokenOf("ann", expiry()));
    await until(() => seen.length === 1);
    const again = client.mutation(api.notes.create, { title: "Once" }, keyed);
    held.resolve(null);
    expect({
      answers: await Promise.all([first, again]),
      sent: seen.length,
    }).toStrictEqual({ answers: [noteId, noteId], sent: 1 });
  });

  it("lets a late refusal of the last person's request clear nothing of the next person's", async () => {
    let token = tokenOf("ann");
    const late = Promise.withResolvers<null>();
    network(async ({ authorization, body }) => {
      const contract = contractIdPattern.exec(body)?.groups?.contractId;
      if (
        authorization === `Bearer ${tokenOf("ann")}` &&
        contract === "notes.list"
      ) {
        await late.promise;
        return Response.json(
          { code: "auth.unauthenticated", message: "Sign in to continue." },
          { status: 401 }
        );
      }
      return {
        title: authorization === `Bearer ${tokenOf("ann")}` ? "Ann's" : "Bo's",
      };
    });
    const client = new GraspClient({
      url: origin,
      getToken: async () => await Promise.resolve(token),
    });
    const internals = clientInternals(client);
    const entry = internals.entry(api.notes.get, { id: noteId });
    const stop = internals.subscribe(entry, () => {});
    await until(() => entry.snapshot.value !== undefined);
    const annsList = failureOf(
      client.query(api.notes.list, { pagination: {} })
    );
    await scheduler();
    token = tokenOf("bo");
    await failureOf(client.query(api.notes.get, { id: idOf(5) }));
    await until(() => entry.snapshot.value !== undefined);
    late.resolve(null);
    await annsList;
    expect(entry.snapshot).toStrictEqual({
      value: { title: "Bo's" },
      error: undefined,
    });
    stop();
  });

  it("gives up on a host that never answers for a token, and never keeps its late answer", async () => {
    vi.useFakeTimers();
    const requests: PromiseWithResolvers<string>[] = [];
    const seen = network(async () => await Promise.resolve(null));
    const client = new GraspClient({
      url: origin,
      getToken: async () => {
        const request = Promise.withResolvers<string>();
        requests.push(request);
        return await request.promise;
      },
    });
    const first = failureOf(client.query(api.notes.get, { id: noteId }));
    await vi.advanceTimersByTimeAsync(30_000);
    const gaveUp = await first;
    requests[0]?.resolve(tokenOf("ann", Math.floor(Date.now() / 1000) + 300));
    const second = client.query(api.notes.get, { id: idOf(2) });
    await vi.advanceTimersByTimeAsync(0);
    requests[1]?.resolve(tokenOf("bo", Math.floor(Date.now() / 1000) + 300));
    await second;
    expect({
      gaveUp: gaveUp.code,
      asked: requests.length,
      sent: seen.map(
        ({ authorization }) => authorization?.includes(".") ?? false
      ),
    }).toStrictEqual({
      gaveUp: "auth.token_unavailable",
      asked: 2,
      sent: [true],
    });
    expect(seen[0]?.authorization).toBe(
      `Bearer ${tokenOf("bo", Math.floor(Date.now() / 1000) + 300)}`
    );
  });

  it("takes an answer that never comes as lost: an action's outcome is then unknown once its key no longer recovers it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      async (_input: string, init: RequestInit): Promise<Response> => {
        const { promise, reject } = Promise.withResolvers<Response>();
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
        return await promise;
      }
    );
    const client = new GraspClient({
      url: origin,
      getToken: async () => await Promise.resolve(tokenOf("ann")),
    });
    const outcome = failureOf(client.action(api.notes.tally));
    // Sent again under its key, which would answer its receipt, for the
    // lost answer's five minutes; past them, unknown.
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    const failure = await outcome;
    expect(failure.code).toBe("submission.outcome_unknown");
    expect(failure.details).toHaveProperty("idempotencyKey");
  });

  it("takes any refusal of a token as one, whatever its body, and asks the host again", async () => {
    const later = Math.floor(Date.now() / 1000) + 300;
    let asked = 0;
    let refuse = true;
    network(async () => {
      await Promise.resolve();
      if (refuse) {
        refuse = false;
        return new Response("<html>Unauthorized</html>", { status: 401 });
      }
      return null;
    });
    const client = new GraspClient({
      url: origin,
      getToken: async () => {
        asked += 1;
        return await Promise.resolve(tokenOf("ann", later));
      },
    });
    // Refused, though not in core's words: never a lost answer to send
    // again after. The next call asks for a token afresh.
    const refused = await failureOf(
      client.query(api.notes.get, { id: idOf(1) })
    );
    const next = await client.query(api.notes.get, { id: idOf(2) });
    expect({ refused: refused.code, next, asked }).toStrictEqual({
      refused: "auth.unauthenticated",
      next: null,
      asked: 2,
    });
  });
});
