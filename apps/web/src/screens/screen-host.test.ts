import { appIdSchema } from "@grasp-os/shared/ids";
import { portTransport } from "@grasp-os/shared/screen-port";
import { screenErrors } from "@grasp-os/shared/screens";
import type { ScreenBundle, ScreenRoute } from "@grasp-os/shared/screens";
import { RpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CoreLink } from "./core-link.ts";
import {
  appDrafts,
  draftGatherMs,
  draftsFor,
  saveDraft,
} from "./form-drafts.ts";
import {
  appScreen,
  callFunction,
  fileRefusal,
  previewTarget,
} from "./screen-host.ts";
import type { ScreenOpening } from "./screen-host.ts";
import type { FrameLink } from "./tab-link.ts";

// The page relaying a screen's function call to core: whatever comes back
// that isn't core's JSON reaches the screen as a coded error, never as
// what the response held.

const outcome = async (call: Promise<unknown>): Promise<unknown> => {
  try {
    return { answered: await call };
  } catch (error) {
    const code: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    return { code };
  }
};

/** No decision answer here asks the person: none is confirmed. */
const confirmNothing = async (): Promise<boolean> =>
  await Promise.resolve(false);

/** A screen opened by its file, which navigates nowhere. */
const noNavigation: ScreenOpening = {
  navigation: {
    navigate: async () => {
      await Promise.resolve();
      throw new Error("Nowhere to go.");
    },
    leaveGuard: () => {
      // Nothing to confirm.
    },
  },
};

/** The frame's lease, and the person it was opened for. */
const frame = { lease: "lease", person: "person" };

describe("a screen's function call through the page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers core's JSON, and turns anything else into a coded error", async () => {
    const responses = [
      Response.json({ result: { ok: true, value: 1 } }),
      Response.json(
        { code: "screen.unreviewed", message: "Not approved." },
        { status: 403 }
      ),
      new Response("<html>Bad gateway</html>", { status: 502 }),
      new Response("<html>a proxy's page</html>", { status: 200 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await Promise.resolve(responses.shift()))
    );
    const results = [];
    for (let call = 0; call < 4; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one response after another
      results.push(await outcome(callFunction("app", frame, "{}")));
    }
    expect(results).toStrictEqual([
      { answered: { result: { ok: true, value: 1 } } },
      { code: "screen.unreviewed" },
      { code: "internal.unexpected" },
      { code: "internal.unexpected" },
    ]);
  });

  it("passes on how long core said to wait, and nothing else of its details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          await Promise.resolve(
            Response.json(
              {
                code: "screen.rate_limited",
                message: "Too much at once.",
                details: { retryAfterMs: 500, requestId: "r1" },
              },
              { status: 429 }
            )
          )
      )
    );
    const refused = await callFunction(
      "app",
      { lease: "lease", person: "person" },
      "{}"
    ).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "screen.rate_limited",
      details: { retryAfterMs: 500 },
    });
    // Nothing else of what core said: not its request ID.
    expect(refused).not.toMatchObject({ details: { requestId: "r1" } });
  });

  it("turns a request that never reached core into a coded error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await Promise.resolve();
        throw new TypeError("Failed to fetch");
      })
    );
    await expect(
      outcome(callFunction("app", frame, "{}"))
    ).resolves.toStrictEqual({ code: "internal.unexpected" });
  });
});

// A running App screen's drafts once core refuses the person: whichever
// way the page hears it, the drafts go and the frame gets no more. Core
// stands in here as one connection, signed in as Ada, whose frames' `delivery`
// answers as the test says, and as the HTTP answers to streaming calls.

/** A tab's session storage, as a browser keeps it. */
const tabStorage = (): Storage => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
};

/**
 * The page's own events, as a browser fires them: `pagehide` calls what
 * listens for it then.
 */
const pageEvents = () => {
  const listeners = new Set<() => void>();
  vi.stubGlobal("addEventListener", (type: string, listener: () => void) => {
    if (type === "pagehide") {
      listeners.add(listener);
    }
  });
  vi.stubGlobal(
    "removeEventListener",
    (_type: string, listener: () => void) => {
      listeners.delete(listener);
    }
  );
  return {
    hide: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

const forbidden = (): Error =>
  Object.assign(new Error("No."), { code: "role.forbidden" });

/**
 * A link to core signed in as Ada, whose frames' `delivery` calls `present`, and
 * whose `whoami`, after the link's own, calls `whoami`.
 */
const linkAsAda = (
  present: () => Promise<string>,
  whoami: () => Promise<{ userId: string }> = async () =>
    await Promise.resolve({ userId: "ada" }),
  watchQuery: (
    app: string,
    lease: string,
    request: string,
    onSnapshot: (push: unknown) => Promise<unknown>
  ) => Promise<unknown> = async () => await Promise.resolve({}),
  /** Runs while core resolves a navigation, before it answers. */
  whileResolving: () => void = () => {
    // Nothing happens meanwhile.
  }
): CoreLink => {
  let asked = 0;
  const session = {
    whoami: async () => {
      asked += 1;
      return asked === 1
        ? await Promise.resolve({ userId: "ada" })
        : await whoami();
    },
    screens: {
      // The frame's own way to its App, for the build core leased it.
      frame: async (app: string, lease: string) =>
        await Promise.resolve({
          delivery: present,
          watchQuery: async (
            request: string,
            onSnapshot: (push: unknown) => Promise<unknown>
          ) => await watchQuery(app, lease, request, onSnapshot),
          close: async () => {
            await Promise.resolve();
          },
          [Symbol.dispose]: () => {
            // Nothing to let go of.
          },
        }),
      version: async () => await Promise.resolve(1),
      // Core resolves only the App's `note` route, as it normalizes it.
      navigate: async (_app: string, route: ScreenRoute) => {
        whileResolving();
        await Promise.resolve();
        if (route.route !== "note") {
          throw screenErrors.create("screen.not_found");
        }
        const id: unknown =
          typeof route.input === "object" && route.input !== null
            ? Reflect.get(route.input, "id")
            : undefined;
        return { screen: "note", route: "note", input: { id, tab: "view" } };
      },
    },
  };
  const core = {
    authenticate: () => session,
    onRpcBroken: () => {
      // Never breaks here.
    },
    [Symbol.dispose]: () => {
      // Nothing to let go of.
    },
  };
  // SAFETY: the page reaches only `authenticate`, `whoami`, the frame's
  // `delivery`, `watchQuery` and `close`, `version`, `onRpcBroken` and
  // disposal, which this stand-in has.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
  const connection = core as unknown as ReturnType<
    NonNullable<ConstructorParameters<typeof CoreLink>[1]>
  >;
  return new CoreLink(
    () => {
      // Never ends here.
    },
    () => connection
  );
};

const bundle: ScreenBundle = {
  app: appIdSchema.parse("notes"),
  name: "Notes",
  version: 1,
  screen: "home",
  route: null,
  input: {},
  artifact: "artifact",
  frameToken: "token",
  lease: "lease",
};

/** The notes App's screen, running for Ada, with a draft she kept. */
const runningWithDraft = async (present: () => Promise<string>) => {
  vi.stubGlobal("sessionStorage", tabStorage());
  const events = pageEvents();
  saveDraft("ada", bundle.app, "n1", "Ada's draft");
  const source = appScreen(
    bundle.app,
    bundle.screen,
    confirmNothing,
    noNavigation
  );
  const link = linkAsAda(present);
  const cleanups: (() => void)[] = [];
  const { target, running } = source.connect(
    link,
    bundle,
    () => {
      // Core never refuses the build here.
    },
    cleanups
  );
  running?.(() => {
    // The page's state isn't looked at here.
  });
  await expect(target.drafts()).resolves.toStrictEqual({ n1: "Ada's draft" });
  return { target, cleanups, events };
};

describe("a running screen's drafts once core refuses the person", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("go when a streaming call is refused, and the frame gets no more", async () => {
    const { target, cleanups } = await runningWithDraft(
      async () => await Promise.resolve("open")
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          await Promise.resolve(
            Response.json(
              { code: "role.forbidden", message: "No." },
              { status: 403 }
            )
          )
      )
    );
    await expect(
      target.streamFunction(
        "stream",
        "{}",
        async () => {
          await Promise.resolve();
        },
        () => {
          // Never followed.
        }
      )
    ).rejects.toMatchObject({ code: "role.forbidden" });
    target.saveDraft("n2", "Another");
    expect({
      frame: await target.drafts(),
      kept: draftsFor("ada", bundle.app),
    }).toStrictEqual({ frame: {}, kept: {} });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("go when a stream core accepted is refused later on", async () => {
    const { target, cleanups } = await runningWithDraft(
      async () => await Promise.resolve("open")
    );
    const refusal = JSON.stringify({
      type: "refused",
      error: { code: "role.forbidden", message: "No." },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await Promise.resolve(new Response(`${refusal}\n`)))
    );
    const delivered = Promise.withResolvers<unknown>();
    await target.streamFunction(
      "stream",
      "{}",
      async (sent) => {
        delivered.resolve(sent);
        await Promise.resolve();
      },
      () => {
        // Ends with the refusal.
      }
    );
    await expect(delivered.promise).resolves.toMatchObject({
      type: "refused",
    });
    await expect(target.drafts()).resolves.toStrictEqual({});
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("go when cancelling a stream is refused", async () => {
    const { target, cleanups } = await runningWithDraft(
      async () => await Promise.resolve("open")
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          await Promise.resolve(
            Response.json(
              { code: "role.forbidden", message: "No." },
              { status: 403 }
            )
          )
      )
    );
    await expect(target.cancelStream("{}")).rejects.toMatchObject({
      code: "role.forbidden",
    });
    await expect(target.drafts()).resolves.toStrictEqual({});
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("go when the page's own check is refused, though the screen asks for nothing", async () => {
    vi.useFakeTimers();
    let refusing = false;
    const { target, cleanups } = await runningWithDraft(async () => {
      if (refusing) {
        throw forbidden();
      }
      return await Promise.resolve("open");
    });
    refusing = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(target.drafts()).resolves.toStrictEqual({});
    for (const cleanup of cleanups) {
      cleanup();
    }
  });
});

describe("a running screen's drafts while it follows a query", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("go when core refuses the person on a query it follows", async () => {
    vi.stubGlobal("sessionStorage", tabStorage());
    pageEvents();
    saveDraft("ada", bundle.app, "n1", "Ada's draft");
    let toPage: ((push: unknown) => Promise<unknown>) | undefined;
    const link = linkAsAda(
      async () => await Promise.resolve("open"),
      undefined,
      async (_app, _lease, _request, onSnapshot) => {
        toPage = onSnapshot;
        return await Promise.resolve({});
      }
    );
    const source = appScreen(
      bundle.app,
      bundle.screen,
      confirmNothing,
      noNavigation
    );
    const cleanups: (() => void)[] = [];
    const { target } = source.connect(
      link,
      bundle,
      () => {
        // Core never refuses the build here.
      },
      cleanups
    );
    const heard: unknown[] = [];
    using toFrame = new RpcStub(async (push: unknown) => {
      heard.push(push);
      await Promise.resolve();
    });
    await target.watchQuery("{}", toFrame);
    await toPage?.({
      revision: 2,
      result: { ok: false, error: { code: "role.forbidden", message: "No." } },
    });
    expect({
      heard: heard.length,
      frame: await target.drafts(),
      kept: draftsFor("ada", bundle.app),
    }).toStrictEqual({ heard: 1, frame: {}, kept: {} });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });
});

describe("a running screen whose query core refuses for its build", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is stopped once core confirms it, and its drafts go", async () => {
    vi.stubGlobal("sessionStorage", tabStorage());
    pageEvents();
    saveDraft("ada", bundle.app, "n1", "Ada's draft");
    let toPage: ((push: unknown) => Promise<unknown>) | undefined;
    let delivery = "open";
    const link = linkAsAda(
      async () => await Promise.resolve(delivery),
      undefined,
      async (_app, _lease, _request, onSnapshot) => {
        toPage = onSnapshot;
        return await Promise.resolve({});
      }
    );
    const source = appScreen(
      bundle.app,
      bundle.screen,
      confirmNothing,
      noNavigation
    );
    const cleanups: (() => void)[] = [];
    const stopped = Promise.withResolvers<string>();
    const { target } = source.connect(
      link,
      bundle,
      (reason) => {
        stopped.resolve(reason);
      },
      cleanups
    );
    using toFrame = new RpcStub(async () => {
      await Promise.resolve();
    });
    await target.watchQuery("{}", toFrame);
    delivery = "revoked";
    await toPage?.({
      revision: 2,
      result: { ok: false, error: { code: "screen.revoked", message: "No." } },
    });
    expect({
      stopped: await stopped.promise,
      kept: draftsFor("ada", bundle.app),
    }).toStrictEqual({ stopped: "revoked", kept: {} });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });
});

describe("an App's drafts when its screen can't be opened", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Opening the notes App's screen, refused with `code`: its drafts after. */
  const refusedWith = async (code: string) => {
    vi.stubGlobal("sessionStorage", tabStorage());
    saveDraft("ada", bundle.app, "n1", "Ada's draft");
    const session = {
      screens: {
        open: async () => {
          await Promise.resolve();
          throw Object.assign(new Error("No."), { code });
        },
      },
    };
    // SAFETY: opening reaches only `screens.open`, which this stand-in has.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
    const asSession = session as unknown as Parameters<
      ReturnType<typeof appScreen>["open"]
    >[0];
    await appScreen(bundle.app, bundle.screen, confirmNothing, noNavigation)
      .open(asSession)
      .catch(() => {
        // Refused, as the test says.
      });
    return draftsFor("ada", bundle.app);
  };

  it("shut every running screen of the App when the person is refused it, a change waiting written nowhere", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("sessionStorage", tabStorage());
      const running = appDrafts(
        bundle.app,
        async () => await Promise.resolve("ada")
      );
      await running.drafts();
      running.save("n1", "typed in the other screen");
      await refusedWith("role.forbidden");
      await vi.advanceTimersByTimeAsync(draftGatherMs);
      running.flush();
      expect(draftsFor("ada", bundle.app)).toStrictEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("stay when only the screen isn't found, and go when the person is refused the App", async () => {
    expect({
      screenGone: await refusedWith("screen.not_found"),
      refused: await refusedWith("role.forbidden"),
    }).toStrictEqual({ screenGone: { n1: "Ada's draft" }, refused: {} });
  });
});

describe("a screen's drafts handed over", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("none while core can't say, the drafts kept for when it can", async () => {
    vi.stubGlobal("sessionStorage", tabStorage());
    pageEvents();
    saveDraft("ada", bundle.app, "n1", "Ada's draft");
    const link = linkAsAda(async () => {
      await Promise.resolve();
      throw new Error("Core is out of reach.");
    });
    const cleanups: (() => void)[] = [];
    const { target } = appScreen(
      bundle.app,
      bundle.screen,
      confirmNothing,
      noNavigation
    ).connect(
      link,
      bundle,
      () => {
        // Core never refuses the build here.
      },
      cleanups
    );
    await expect(target.drafts()).rejects.toThrow("out of reach");
    expect(draftsFor("ada", bundle.app)).toStrictEqual({ n1: "Ada's draft" });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("only while core still hands its build the App's data", async () => {
    vi.stubGlobal("sessionStorage", tabStorage());
    pageEvents();
    saveDraft("ada", bundle.app, "n1", "Ada's draft");
    const link = linkAsAda(async () => await Promise.resolve("revoked"));
    const stopped: string[] = [];
    const cleanups: (() => void)[] = [];
    const { target } = appScreen(
      bundle.app,
      bundle.screen,
      confirmNothing,
      noNavigation
    ).connect(
      link,
      bundle,
      (reason) => {
        stopped.push(reason);
      },
      cleanups
    );
    expect({ handed: await target.drafts(), stopped }).toStrictEqual({
      handed: {},
      stopped: ["revoked"],
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });
});

describe("a running screen's drafts as the page goes away", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("are written as the page hides, though their gathering hasn't ended", async () => {
    vi.useFakeTimers();
    const { target, cleanups, events } = await runningWithDraft(
      async () => await Promise.resolve("open")
    );
    target.saveDraft("n1", "Typed just before the refresh");
    events.hide();
    expect(draftsFor("ada", bundle.app)).toStrictEqual({
      n1: "Typed just before the refresh",
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });
});

describe("a running screen's drafts once core stops its build", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keep nothing of a save still waiting to know who is signed in", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", tabStorage());
    pageEvents();
    const person = Promise.withResolvers<{ userId: string }>();
    const link = linkAsAda(
      async () => await Promise.resolve("revoked"),
      async () => await person.promise
    );
    await link.session();
    const source = appScreen(
      bundle.app,
      bundle.screen,
      confirmNothing,
      noNavigation
    );
    const stopped: string[] = [];
    const refused = (reason: string): void => {
      stopped.push(reason);
    };
    const cleanups: (() => void)[] = [];
    const { target, running } = source.connect(link, bundle, refused, cleanups);
    running?.(() => {
      // The page's state isn't looked at here.
    });
    target.saveDraft("n1", "Typed as it was revoked");
    await vi.advanceTimersByTimeAsync(30_000);
    person.resolve({ userId: "ada" });
    await vi.advanceTimersByTimeAsync(draftGatherMs);
    expect({ stopped, kept: draftsFor("ada", bundle.app) }).toStrictEqual({
      stopped: ["revoked"],
      kept: {},
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });
});

/** Core's refusal `code`, with `status`. */
const refusal = (code: string, status: number): Response =>
  Response.json({ code, message: "Refused." }, { status });

describe("core's answer to a screen's file request", () => {
  it("stops the frame for someone else's session, and asks again for its build when refused for it", async () => {
    await expect(
      Promise.all([
        fileRefusal(refusal("auth.principal_changed", 401)),
        fileRefusal(refusal("screen.revoked", 403)),
        fileRefusal(refusal("screen.unreviewed", 403)),
        fileRefusal(refusal("file.not_found", 404)),
        fileRefusal(Response.json({ code: "screen.revoked" })),
      ])
    ).resolves.toStrictEqual([
      "principal-changed",
      "build",
      "build",
      undefined,
      undefined,
    ]);
  });
});

/**
 * Core, over a real Cap'n Web session, as far as a preview's stream
 * reaches it: its chats are itself, it sends each stream `frames` at
 * once, and the hold on a stream it answers is one of its own, which only
 * gets released.
 */
class PreviewCore extends RpcTarget {
  released = false;
  readonly #frames: readonly unknown[];

  constructor(frames: readonly unknown[] = []) {
    super();
    this.#frames = frames;
  }

  get chats(): this {
    return this;
  }

  previewStream(
    _chatId: string,
    _app: string,
    _revision: number,
    _what: string,
    _request: string,
    onFrame: (sent: unknown) => Promise<unknown>
  ): PreviewCore {
    for (const sent of this.#frames) {
      void onFrame(sent).catch(() => {
        // The page's side is gone.
      });
    }
    return new PreviewCore();
  }

  release(): void {
    this.released = true;
  }
}

/**
 * A preview's stream on the page, over a real session with core sending
 * `sending`; `taking` is how the frame takes each. `drop` ends the session
 * from core's side, as a dropped connection does.
 */
const previewStreamOver = async (
  sending: readonly unknown[],
  taking: () => Promise<unknown>
) => {
  const { port1, port2 } = new MessageChannel();
  // oxlint-disable-next-line no-new -- the session serves core's side
  new RpcSession(portTransport(port1), new PreviewCore(sending));
  const core = new RpcSession<PreviewCore>(
    portTransport(port2)
  ).getRemoteMain();
  const link = {
    session: async () => await Promise.resolve(core),
    person: async () => await Promise.resolve("ada"),
    retrying: async <T>(run: (session: unknown) => Promise<T>) =>
      await run(core),
  };
  // SAFETY: a preview's stream reaches only `chats.previewStream`, which
  // this stand-in has.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
  const asLink = link as unknown as FrameLink;
  const target = previewTarget(asLink, "chat", {
    ...bundle,
    revision: 1,
    screens: ["home"],
  });
  const frames: unknown[] = [];
  const seen = { frames, ended: 0 };
  await target.streamFunction(
    "stream",
    "{}",
    async (sent) => {
      seen.frames.push(sent);
      return await taking();
    },
    () => {
      seen.ended += 1;
    }
  );
  return {
    seen,
    drop: () => {
      port1.postMessage(null);
    },
    close: () => {
      port1.close();
      port2.close();
    },
  };
};

describe("a preview's stream through the page", () => {
  it("tells the frame `closed` and ends once its connection drops before the last frame", async () => {
    const stream = await previewStreamOver(
      [],
      async () => await Promise.resolve(null)
    );
    stream.drop();
    await vi.waitFor(() => {
      expect(stream.seen).toStrictEqual({
        frames: [{ type: "closed" }],
        ended: 1,
      });
    });
    stream.close();
  });

  it("sends no `closed` after a last frame the frame is still taking when the connection drops", async () => {
    const result = { type: "result", seq: 1, result: { ok: true, value: 1 } };
    const stream = await previewStreamOver(
      [result],
      // Never taken.
      async () => await Promise.withResolvers<null>().promise
    );
    await vi.waitFor(() => {
      expect(stream.seen.frames).toStrictEqual([result]);
    });
    stream.drop();
    // A break handled now would have sent `closed` within a tick or two.
    const waited = Promise.withResolvers<null>();
    setTimeout(() => {
      waited.resolve(null);
    }, 50);
    await waited.promise;
    expect(stream.seen).toStrictEqual({ frames: [result], ended: 0 });
    stream.close();
  });
});

describe("a screen's navigation, as the page takes it", () => {
  it("is refused in a preview, before anything asks core or moves the page", async () => {
    let asked = 0;
    const link = {
      session: async () => {
        asked += 1;
        return await Promise.reject(new Error("Not asked in a preview."));
      },
      person: async () => await Promise.resolve("ada"),
    };
    // SAFETY: a preview's navigation reaches nothing of the link; counted.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
    const asLink = link as unknown as FrameLink;
    const target = previewTarget(asLink, "chat", {
      ...bundle,
      revision: 1,
      screens: ["home"],
    });
    const refused = await outcome(
      target.navigate({ screen: "note", input: { id: "n1" } })
    );
    expect({ refused, asked }).toStrictEqual({
      refused: { code: "app.preview_side_effect" },
      asked: 0,
    });
  });

  it("goes only where core resolved, with what core normalized, and nowhere when core refuses", async () => {
    vi.stubGlobal("sessionStorage", tabStorage());
    pageEvents();
    const went: { target: unknown; replace: boolean }[] = [];
    const guards: boolean[] = [];
    const opening: ScreenOpening = {
      navigation: {
        navigate: async (target, replace) => {
          went.push({ target, replace });
          await Promise.resolve();
        },
        leaveGuard: (guarded) => {
          guards.push(guarded);
        },
      },
    };
    const link = linkAsAda(async () => await Promise.resolve("open"));
    const cleanups: (() => void)[] = [];
    const { target } = appScreen(
      bundle.app,
      bundle.screen,
      confirmNothing,
      opening
    ).connect(
      link,
      { ...bundle, route: "notes", input: { page: 2 } },
      () => {
        // Core never refuses the build here.
      },
      cleanups
    );
    const input = target.input();
    await target.navigate({ screen: "note", input: { id: "n1" } });
    await target.navigate({
      screen: "note",
      input: { id: "n2" },
      replace: true,
    });
    const refused = await target
      .navigate({ screen: "settings", input: {} })
      .then(
        () => "went",
        (error: unknown) => screenErrors.codeOf(error)
      );
    target.leaveGuard(true);
    for (const cleanup of cleanups) {
      cleanup();
    }
    expect({ input, went, refused, guards }).toStrictEqual({
      input: { page: 2 },
      went: [
        {
          target: {
            screen: "note",
            route: "note",
            input: { id: "n1", tab: "view" },
          },
          replace: false,
        },
        {
          target: {
            screen: "note",
            route: "note",
            input: { id: "n2", tab: "view" },
          },
          replace: true,
        },
      ],
      refused: "screen.not_found",
      guards: [true],
    });
  });

  it("goes nowhere once the screen stopped while core resolved where to", async () => {
    vi.stubGlobal("sessionStorage", tabStorage());
    pageEvents();
    const went: unknown[] = [];
    const opening: ScreenOpening = {
      navigation: {
        navigate: async (target) => {
          went.push(target);
          await Promise.resolve();
        },
        leaveGuard: () => {
          // Not asked here.
        },
      },
    };
    const cleanups: (() => void)[] = [];
    // The person leaves the screen before core answered.
    const link = linkAsAda(
      async () => await Promise.resolve("open"),
      undefined,
      undefined,
      () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      }
    );
    const { target } = appScreen(
      bundle.app,
      bundle.screen,
      confirmNothing,
      opening
    ).connect(
      link,
      bundle,
      () => {
        // Core never refuses the build here.
      },
      cleanups
    );
    const stopped = await target
      .navigate({ screen: "note", input: { id: "n1" } })
      .then(
        () => false,
        () => true
      );
    expect({ stopped, went }).toStrictEqual({ stopped: true, went: [] });
  });
});
