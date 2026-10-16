import { GraspClient } from "@grasp-os/sdk/client";
import type { GraspError } from "@grasp-os/sdk/client";
import { clientInternals } from "@grasp-os/sdk/host";
import { toBase64Url } from "@grasp-os/shared/encoding";
import {
  appTokenPath,
  portableLivePath,
  tokenExpiredCloseCode,
} from "@grasp-os/shared/portable";
import type {
  PortableLiveApi,
  PortableQueriesApi,
} from "@grasp-os/shared/portable";
import type { Role } from "@grasp-os/shared/roles";
import { screenLimits } from "@grasp-os/shared/screens";
import type { QuerySnapshotPush } from "@grasp-os/shared/screens";
import { newWebSocketRpcSession } from "capnweb";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { mockIdp } from "./idp.ts";
import { apiOf, notesFiles } from "./notes-client-app.ts";
import { closeWhenTestEnds } from "./open-sockets.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { callAuth, outcome, routed, signedInApi } from "./sign-in.ts";

// A portable host (spec 10.7.1) following its App's live queries (spec
// 11) over core's token-authenticated connection
// (`/api/portable/app-live/<app>`, src/portable-live.ts), against core's
// real routes. The ways it can fail come first: anything reachable before
// a token connects, a cookie standing in for one, a token for another App
// or expired; a session that ends, a role lost or a token that expires
// mid-subscription; a renewal for someone else; another App's query;
// code nobody approved getting sensitive data; a connection followed past
// its bounds. Then the client: changes reach it without a read of its
// own, an expired token is replaced without clearing what it shows, and
// one person's connection is never used for the next.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** A builder's Notes App, made current, its data `ordinary` unless `sensitive`. */
const notesApp = async ({ sensitive = false } = {}) => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(
    id,
    notesFiles,
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  if (!sensitive) {
    const { generation } = await admin.api.screenTrust.review(id);
    await admin.api.screenTrust.classify(id, "ordinary", generation);
  }
  const release = await loadRelease(env, id, version);
  return { builder, app: id, release, api: apiOf(release) };
};

type NotesApp = Awaited<ReturnType<typeof notesApp>>;

/** Adds `member` to `notes`' App as a user. */
const share = async (notes: NotesApp, member: Person): Promise<void> => {
  await notes.builder.api.apps.members.add(notes.app, {
    type: "person",
    id: member.userId,
    role: "user",
  });
};

const issuedSchema = z.object({ token: z.string() });

/** A token for `cookie`'s person to use `app` from a portable host. */
const tokenFor = async (cookie: string, app: string): Promise<string> => {
  const response = await routed(`${appTokenPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie,
    },
    body: "{}",
  });
  expect(response.status).toBe(200);
  return issuedSchema.parse(await response.json()).token;
};

/** A request for `path` of `notes`' App with `input`, as the client writes it. */
const requestFor = (
  { release }: Pick<NotesApp, "release">,
  path: string,
  input: unknown
): string =>
  JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: path,
      fingerprint: release.fingerprints[path],
      kind: release.app.operations[path]?.kind,
    },
    input,
  });

/** Where another site's page runs: the token is all it has. */
const hostOrigin = "https://notes.elsewhere.test";

/**
 * Opens `app`'s live connection as a browser on another site would, with
 * `cookie` (a browser sends the person's cookies with any upgrade).
 */
const openLive = async <Api extends object = PortableLiveApi>(
  app: string,
  cookie?: string
) => {
  const response = await routed(`${portableLivePath}/${app}`, {
    headers: {
      Upgrade: "websocket",
      Origin: hostOrigin,
      ...(cookie === undefined ? {} : { cookie }),
    },
  });
  const socket = response.webSocket;
  if (!socket) {
    throw new Error(`Expected a WebSocket, got ${response.status}`);
  }
  const closed = Promise.withResolvers<number>();
  socket.addEventListener("close", (event) => {
    closed.resolve(event.code);
  });
  socket.accept();
  closeWhenTestEnds(socket);
  const live = newWebSocketRpcSession<Api>(socket);
  return { live, closed: closed.promise };
};

/** Every push a raw subscription got, and its first that holds data. */
const pushes = () => {
  const got: QuerySnapshotPush[] = [];
  return {
    got,
    onSnapshot: (push: QuerySnapshotPush): void => {
      got.push(push);
    },
  };
};

/** What `seen` showed from `code` on. */
const fromRefusal = (seen: unknown[], code: string) =>
  seen.slice(seen.indexOf(code));

/** How long a push may take to arrive, and how often to look. */
const pushWait = { timeout: 20_000, interval: 50 };

/** Once `look` passes. */
const eventually = async (look: () => void): Promise<void> => {
  await vi.waitFor(look, pushWait);
};

/** What `closed` settles with within `ms`, or `"open"`. */
const closedWithin = async (
  closed: Promise<number>,
  ms = 2000
): Promise<number | "open"> => {
  const { promise, resolve } = Promise.withResolvers<"open">();
  const timer = setTimeout(() => {
    resolve("open");
  }, ms);
  try {
    return await Promise.race([closed, promise]);
  } finally {
    clearTimeout(timer);
  }
};

/** The titles a list snapshot shows, or what it failed with. */
const shown = (snapshot: { value: unknown; error: GraspError | undefined }) => {
  if (snapshot.error !== undefined) {
    return snapshot.error.code;
  }
  const page = z
    .object({ items: z.array(z.object({ title: z.string() })) })
    .safeParse(snapshot.value);
  return page.success ? page.data.items.map(({ title }) => title) : undefined;
};

/** The titles a raw push holds, or the code it was refused with. */
const titlesOf = (push: QuerySnapshotPush | undefined) => {
  const read = z
    .union([
      z.object({
        ok: z.literal(true),
        value: z.object({ items: z.array(z.object({ title: z.string() })) }),
      }),
      z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
    ])
    .safeParse(push?.result);
  if (!read.success) {
    return "unreadable";
  }
  return read.data.ok
    ? read.data.value.items.map(({ title }) => title)
    : read.data.error.code;
};

/** One socket the host's page opened, as the browser shows it. */
interface HostSocket {
  readonly url: string;
  /** Its close code, once closed. */
  code: number | undefined;
}

/**
 * The host page's browser: `fetch` and `WebSocket` of the deployment
 * reach core through the router; each socket's upgrade carries `cookie`,
 * as a browser sends the person's cookies with it whatever the page does.
 * Answers what the page sent: its calls, and its sockets.
 */
const hostBrowser = ({ cookie }: { cookie?: string } = {}) => {
  const calls: string[] = [];
  const sockets: HostSocket[] = [];
  const outside = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== clientOrigin) {
        return await outside(input, init);
      }
      calls.push(url.pathname);
      return await routed(url.pathname, {
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body ?? null,
      });
    }
  );
  class BrowserSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    binaryType = "blob";
    readonly #seen: HostSocket;
    #socket: WebSocket | undefined;

    constructor(url: string) {
      super();
      this.#seen = { url, code: undefined };
      sockets.push(this.#seen);
      void this.#open(new URL(url));
    }

    async #open(url: URL): Promise<void> {
      const response = await routed(url.pathname, {
        headers: {
          Upgrade: "websocket",
          Origin: hostOrigin,
          ...(cookie === undefined ? {} : { cookie }),
        },
      });
      const socket = response.webSocket;
      if (!socket) {
        this.readyState = 3;
        this.dispatchEvent(new Event("error"));
        return;
      }
      socket.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : "";
        this.dispatchEvent(new MessageEvent("message", { data }));
      });
      socket.addEventListener("close", (event) => {
        this.readyState = 3;
        this.#seen.code ??= event.code;
        this.dispatchEvent(
          new CloseEvent("close", { code: event.code, reason: event.reason })
        );
      });
      socket.accept();
      closeWhenTestEnds(socket);
      this.#socket = socket;
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }

    send(data: string): void {
      this.#socket?.send(data);
    }

    close(code = 1000, reason = ""): void {
      this.#seen.code ??= code;
      this.readyState = 3;
      this.#socket?.close(code, reason);
    }
  }
  vi.stubGlobal("WebSocket", BrowserSocket);
  return { calls, sockets };
};

/** A client a portable host makes, its token whatever `token()` says now. */
const portableClient = (token: () => string | null, asked?: () => void) =>
  new GraspClient({
    url: clientOrigin,
    getToken: async () => {
      asked?.();
      return await Promise.resolve(token());
    },
  });

/** Follows `reference` with `args` as a component would; every snapshot shown kept. */
const reading = (client: GraspClient, reference: unknown, args: unknown) => {
  const internals = clientInternals(client);
  const entry = internals.entry(reference, args);
  const seen: (string[] | string)[] = [];
  const stop = internals.subscribe(entry, () => {
    seen.push(shown(entry.snapshot) ?? "loading");
  });
  return { stop, seen, now: () => shown(entry.snapshot) };
};

/** Runs `run` with the date `ms` on, moving on from there. */
const after = async <T>(ms: number, run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.now() + ms);
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** Past an App token's lifetime (5 minutes). */
const pastExpiry = 5 * 60_000 + 1000;

/** A list of the App's notes, as a raw subscription asks for it. */
const listOf = (notes: NotesApp): string =>
  requestFor(notes, "notes.list", { pagination: {} });

/** Whether `seen` shows the member's notes alone. */
const membersOnly = (seen: string[] | string): boolean =>
  Array.isArray(seen) &&
  seen.length > 0 &&
  seen.every((title) => title === "Elsewhere");

describe("a portable host's live queries", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reaches nothing before a token connects, and connects only with a current one for exactly its App", async () => {
    const notes = await notesApp();
    const other = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    const othersToken = await tokenFor(other.builder.session, other.app);
    const [header, , signature] = token.split(".");
    const forged = `${header}.${toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ sub: other.builder.userId, app: notes.app })
      )
    )}.${signature}`;
    // The person's own cookie rides along with every upgrade: it lends
    // the connection nothing.
    const refused = async (sent: string) => {
      const { live, closed } = await openLive(notes.app, notes.builder.session);
      const watched = live.connect(sent).watchQuery(listOf(notes), () => {});
      return {
        code: await outcome(watched),
        closed: await closedWithin(closed),
      };
    };
    const expired = await after(pastExpiry, async () => await refused(token));
    expect({
      garbage: await refused("not a token"),
      forged: await refused(forged),
      anotherApps: await refused(othersToken),
      expired,
    }).toStrictEqual({
      garbage: { code: "auth.unauthenticated", closed: 4401 },
      forged: { code: "auth.unauthenticated", closed: 4401 },
      anotherApps: { code: "auth.unauthenticated", closed: 4401 },
      expired: { code: "auth.unauthenticated", closed: 4401 },
    });

    // Before `connect`, its main object has nothing else to call.
    // A page someone changed may ask for anything.
    const bare = await openLive<PortableLiveApi & PortableQueriesApi>(
      notes.app,
      notes.builder.session
    );
    await expect(
      outcome(bare.live.watchQuery(listOf(notes), () => {}))
    ).resolves.not.toBe("ok");

    // One `connect` a connection: a second, with anyone's token, is refused.
    const { live } = await openLive(notes.app);
    const { got, onSnapshot } = pushes();
    const queries = live.connect(token);
    await queries.watchQuery(listOf(notes), onSnapshot);
    await eventually(() => {
      expect(titlesOf(got.at(-1))).toStrictEqual([]);
    });
    await expect(outcome(live.connect(othersToken))).resolves.toBe(
      "auth.unauthenticated"
    );
  });

  it("closes a connection that doesn't connect in time", async () => {
    const notes = await notesApp();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { closed } = await openLive(notes.app);
    await vi.advanceTimersByTimeAsync(10_001);
    vi.useRealTimers();
    await expect(closedWithin(closed)).resolves.toBe(4401);
  });

  it("ends every subscription with the person's role, and with the session its token came from", async () => {
    const notes = await notesApp();
    const removed = await personApi("user");
    const writer = await personApi("user");
    await share(notes, removed);
    await share(notes, writer);
    hostBrowser();
    const builderToken = await tokenFor(notes.builder.session, notes.app);
    const removedToken = await tokenFor(removed.session, notes.app);
    const writerToken = await tokenFor(writer.session, notes.app);
    const builders = portableClient(() => builderToken);
    const theirs = portableClient(() => removedToken);
    const writers = portableClient(() => writerToken);
    await builders.mutation(notes.api.create, { title: "The builder's" });
    await theirs.mutation(notes.api.create, { title: "Theirs" });
    const builderList = reading(builders, notes.api.list, { pagination: {} });
    const theirList = reading(theirs, notes.api.list, { pagination: {} });
    await eventually(() => {
      expect([builderList.now(), theirList.now()]).toStrictEqual([
        ["The builder's"],
        ["Theirs"],
      ]);
    });

    // Any commit to what a query read has it read again, as its token's
    // person now.
    const commitUntil = async (done: () => boolean): Promise<void> => {
      await after(5000, async () => {
        await vi.waitFor(
          async () => {
            await writers.mutation(notes.api.create, { title: "Again" });
            expect(done()).toBeTruthy();
          },
          { timeout: 10_000, interval: 250 }
        );
      });
    };
    await notes.builder.api.apps.members.remove(notes.app, {
      type: "person",
      id: removed.userId,
    });
    await commitUntil(() => theirList.now() === "app.not_found");
    await callAuth("/sign-out", notes.builder.session, {});
    await commitUntil(() => builderList.now() === "auth.unauthenticated");

    // Nothing of what either read is shown once it was refused.
    expect({
      builder: fromRefusal(builderList.seen, "auth.unauthenticated"),
      theirs: fromRefusal(theirList.seen, "app.not_found"),
    }).toStrictEqual({
      builder: ["auth.unauthenticated"],
      theirs: ["app.not_found"],
    });
  });

  it("closes a connection whose token expired unrenewed, pushing nothing more, and keeps one renewed", async () => {
    const notes = await notesApp();
    const member = await personApi("user");
    await share(notes, member);
    const token = await tokenFor(notes.builder.session, notes.app);
    hostBrowser();

    // One left to expire, and one renewed three minutes in.
    const lapsing = await openLive(notes.app);
    const lapsed = pushes();
    await lapsing.live
      .connect(token)
      .watchQuery(listOf(notes), lapsed.onSnapshot);
    const renewing = await openLive(notes.app);
    const renewed = pushes();
    const queries = renewing.live.connect(token);
    await queries.watchQuery(listOf(notes), renewed.onSnapshot);
    await eventually(() => {
      expect([
        titlesOf(lapsed.got.at(-1)),
        titlesOf(renewed.got.at(-1)),
      ]).toStrictEqual([[], []]);
    });
    await after(3 * 60_000, async () => {
      const next = await tokenFor(notes.builder.session, notes.app);
      await queries.renew(next);
    });

    const pushed = lapsed.got.length;
    await after(pastExpiry, async () => {
      const fresh = await tokenFor(member.session, notes.app);
      const writer = portableClient(() => fresh);
      await writer.mutation(notes.api.create, { title: "Later" });
      await expect(closedWithin(lapsing.closed, 10_000)).resolves.toBe(
        tokenExpiredCloseCode
      );
      // The renewed one goes on: the member's write had it read again.
      await eventually(() => {
        expect(renewed.got.length).toBeGreaterThan(1);
      });
    });
    expect({
      lapsed: lapsed.got.length,
      renewed: titlesOf(renewed.got.at(-1)),
      stillOpen: await closedWithin(renewing.closed, 100),
    }).toStrictEqual({ lapsed: pushed, renewed: [], stillOpen: "open" });
  });

  it("refuses a renewal for anyone else, closing the connection, and one for another App, keeping it", async () => {
    const notes = await notesApp();
    const other = await notesApp();
    const member = await personApi("user");
    await share(notes, member);
    const token = await tokenFor(notes.builder.session, notes.app);
    const othersToken = await tokenFor(other.builder.session, other.app);
    const memberToken = await tokenFor(member.session, notes.app);
    const { live, closed } = await openLive(notes.app);
    const queries = live.connect(token);
    const anotherApp = await outcome(queries.renew(othersToken));
    const { got, onSnapshot } = pushes();
    await queries.watchQuery(listOf(notes), onSnapshot);
    await eventually(() => {
      expect(titlesOf(got.at(-1))).toStrictEqual([]);
    });
    const someoneElse = await outcome(queries.renew(memberToken));
    expect({
      anotherApp,
      someoneElse,
      closed: await closedWithin(closed),
    }).toStrictEqual({
      anotherApp: "auth.unauthenticated",
      someoneElse: "auth.principal_changed",
      closed: 4401,
    });
  });

  it("counts each renewal against the person's requests of the App", async () => {
    // The bucket fills again with time, so the clock is stopped. A fresh
    // person and App, so no other test's count.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const notes = await notesApp();
      const token = await tokenFor(notes.builder.session, notes.app);
      const { live } = await openLive(notes.app);
      const queries = live.connect(token);
      const { burst } = screenLimits.requests;
      const renewed: string[] = [];
      for (let count = 0; count < burst; count += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one renewal after another, as a host sends them
        renewed.push(await outcome(queries.renew(token)));
      }
      // Within the burst, however many requests getting the token and
      // connecting took: never renewed without limit.
      expect({
        first: renewed[0],
        last: renewed.at(-1),
      }).toStrictEqual({ first: "ok", last: "screen.rate_limited" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses another App's query, sensitive data, and a connection's queries past its bound", async () => {
    const notes = await notesApp();
    const other = await notesApp();
    const sensitive = await notesApp({ sensitive: true });
    const token = await tokenFor(notes.builder.session, notes.app);
    const { live } = await openLive(notes.app);
    const queries = live.connect(token);
    const { got, onSnapshot } = pushes();
    await queries.watchQuery(listOf(other), onSnapshot);
    await eventually(() => {
      expect(got).toHaveLength(1);
    });
    expect(got[0]?.result).toMatchObject({ ok: false });

    const sensitiveToken = await tokenFor(
      sensitive.builder.session,
      sensitive.app
    );
    const closedOff = await openLive(sensitive.app);
    await expect(
      outcome(
        closedOff.live
          .connect(sensitiveToken)
          .watchQuery(listOf(sensitive), () => {})
      )
    ).resolves.toBe("screen.unreviewed");

    // Following counts as a request: seventeen a minute, renewed as it
    // goes, until a hundred are followed at once.
    const bounded = await openLive(notes.app);
    const many = bounded.live.connect(token);
    const answers: string[] = [];
    for (let minute = 0; minute < 6; minute += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one minute after the other
      const batch = await after(minute * 60_000 + 1000, async () => {
        if (minute === 3) {
          await many.renew(await tokenFor(notes.builder.session, notes.app));
        }
        return await Promise.all(
          Array.from(
            { length: 17 },
            async (_, at) =>
              await outcome(
                many.watchQuery(
                  JSON.stringify({ n: minute * 17 + at }),
                  () => {}
                )
              )
          )
        );
      });
      answers.push(...batch);
    }
    expect({
      followed: answers.filter((answer) => answer === "ok").length,
      refused: [...new Set(answers.filter((answer) => answer !== "ok"))],
    }).toStrictEqual({ followed: 100, refused: ["screen.too_many_queries"] });
  });

  it("shows a change made elsewhere without reading again, over one connection its token opened", async () => {
    const notes = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    const browser = hostBrowser({ cookie: notes.builder.session });
    const client = portableClient(() => token);
    const elsewhere = portableClient(() => token);
    const list = reading(client, notes.api.list, { pagination: {} });
    const again = reading(client, notes.api.get, {
      id: "01890000-0000-7000-8000-000000000001",
    });
    await eventually(() => {
      expect(list.now()).toStrictEqual([]);
    });

    await client.mutation(notes.api.create, { title: "Mine" });
    await elsewhere.mutation(notes.api.create, { title: "From elsewhere" });
    await eventually(() => {
      expect(list.now()).toStrictEqual(
        expect.arrayContaining(["Mine", "From elsewhere"])
      );
    });
    // Two saves, and nothing read: what changed was pushed. One
    // connection for the App, whatever it follows.
    expect({
      calls: browser.calls.length,
      sockets: browser.sockets.map(({ url }) => url),
    }).toStrictEqual({
      calls: 2,
      sockets: [
        `wss://${new URL(clientOrigin).host}${portableLivePath}/${notes.app}`,
      ],
    });
    again.stop();
    list.stop();
  });

  it("replaces an expired token without clearing what it shows, and never follows for the next person on the last one's connection", async () => {
    const notes = await notesApp();
    const member = await personApi("user");
    await share(notes, member);
    let current = await tokenFor(notes.builder.session, notes.app);
    let asked = 0;
    const browser = hostBrowser();
    const client = portableClient(
      () => current,
      () => {
        asked += 1;
      }
    );
    await client.mutation(notes.api.create, { title: "The builder's" });
    const list = reading(client, notes.api.list, { pagination: {} });
    await eventually(() => {
      expect(list.now()).toStrictEqual(["The builder's"]);
    });

    await after(pastExpiry, async () => {
      current = await tokenFor(notes.builder.session, notes.app);
      const memberToken = await tokenFor(member.session, notes.app);
      const writer = portableClient(() => memberToken);
      await vi.waitFor(
        async () => {
          await writer.mutation(notes.api.create, { title: "Elsewhere" });
          expect(browser.sockets[0]?.code).toBe(tokenExpiredCloseCode);
        },
        { timeout: 10_000, interval: 250 }
      );
      await eventually(() => {
        expect(browser.sockets).toHaveLength(2);
      });
      await client.mutation(notes.api.create, { title: "After" });
      await eventually(() => {
        expect(list.now()).toStrictEqual(
          expect.arrayContaining(["The builder's", "After"])
        );
      });
    });
    // Never cleared: the expiry was no refusal.
    expect(
      list.seen.filter((seen) => typeof seen === "string" && seen !== "loading")
    ).toStrictEqual([]);
    const askedBefore = asked;

    // Someone else signs in on the host once the builder's token is near
    // its expiry, when the client asks for the next: their token's first
    // use clears the builder's notes, and the builder's connection closes
    // before anything is followed for the member.
    await after(2 * pastExpiry, async () => {
      current = await tokenFor(member.session, notes.app);
      await client.query(notes.api.list, { pagination: {} }).catch(() => null);
      await eventually(() => {
        expect(membersOnly(list.seen.at(-1) ?? [])).toBeTruthy();
      });
    });
    const afterSwitch = list.seen.slice(list.seen.lastIndexOf("loading"));
    expect({
      askedAgain: asked > askedBefore,
      sockets: browser.sockets.length,
      builderClosed: browser.sockets[1]?.code !== undefined,
      cleared: afterSwitch[0],
      thenOnlyTheMembers: afterSwitch
        .slice(1)
        .every((seen) => membersOnly(seen)),
    }).toStrictEqual({
      askedAgain: true,
      sockets: 3,
      builderClosed: true,
      cleared: "loading",
      thenOnlyTheMembers: true,
    });
    list.stop();
  });
});
