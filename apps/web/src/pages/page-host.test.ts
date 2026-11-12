import { appErrors } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { pageLeaseHeader } from "@grasp-os/shared/pages";
import type { AppVersionPush, PageBundle } from "@grasp-os/shared/pages";
import { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { wait } from "../core.ts";
import { CoreLink } from "./core-link.ts";
import {
  appPage,
  callFunction,
  failureOf,
  fileRefusal,
  previewTarget,
} from "./page-host.ts";
import type { FrameLocation, PageOpening, PageState } from "./page-host.ts";
import type { FrameLink } from "./tab-link.ts";

// The page relaying a page's function call to core: whatever comes back
// that isn't core's JSON reaches the page as a coded error, never as
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

/** A link confirmation the person never gives. */
const confirmNoLink = async (): Promise<boolean> =>
  await Promise.resolve(false);

/** Where in the App a frame is: at its `/`, which nothing moves. */
const atRoot: FrameLocation = {
  current: () => "/",
  moved: () => {
    // The page keeps no address here.
  },
  follow: () => {
    // The page's address never moves here.
  },
};

/** An App's pages at its `/`, holding nothing to confirm leaving. */
const noNavigation: PageOpening = {
  location: atRoot,
  leaveGuard: () => {
    // Nothing to confirm.
  },
};

/** The frame's lease, and the person it was opened for. */
const frame = { lease: "lease", person: "person" };

describe("a page's function call through the page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers core's JSON, and turns anything else into a coded error", async () => {
    const responses = [
      Response.json({ result: { ok: true, value: 1 } }),
      Response.json(
        { code: "page.unreviewed", message: "Not approved." },
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
      { code: "page.unreviewed" },
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
                code: "page.rate_limited",
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
      code: "page.rate_limited",
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

// Core stands in here as one connection, signed in as Ada, whose frames'
// `delivery` answers as the test says, and as the HTTP answers to
// streaming calls.

/** A link to core signed in as Ada, whose frames' `delivery` calls `present`. */
const linkAsAda = (
  present: () => Promise<string>,
  watchQuery: (
    app: string,
    lease: string,
    request: string,
    onSnapshot: (push: unknown) => Promise<unknown>
  ) => Promise<unknown> = async () => await Promise.resolve({}),
  /** Runs while core resolves a navigation, before it answers. */
  whileResolving: () => void = () => {
    // Nothing happens meanwhile.
  },
  /** Core following the App's version for the page (`watchVersion`). */
  watchVersion: (
    app: string,
    onVersion: (push: AppVersionPush) => void
  ) => Promise<unknown> = async () =>
    await Promise.resolve({
      release: async () => {
        await Promise.resolve();
      },
    })
): CoreLink => {
  const session = {
    whoami: async () => await Promise.resolve({ userId: "ada" }),
    pages: {
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
      watchVersion,
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
  // `delivery`, `watchQuery` and `close`, `watchVersion`,
  // `onRpcBroken` and disposal, which this stand-in has.
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

const bundle: PageBundle = {
  app: appIdSchema.parse("notes"),
  name: "Notes",
  version: 1,
  artifact: "artifact",
  frameToken: "token",
  lease: "lease",
};

/** The notes App's page, running for Ada. */
const runningPage = async (
  present: () => Promise<string>,
  states: PageState[] = []
) => {
  // What core pushes the page about the App's version, once it follows it.
  const following = Promise.withResolvers<(push: AppVersionPush) => void>();
  const source = appPage(
    bundle.app,
    confirmNothing,
    confirmNoLink,
    noNavigation
  );
  const link = linkAsAda(
    present,
    undefined,
    undefined,
    async (_app, onVersion) => {
      following.resolve(onVersion);
      return await Promise.resolve({
        release: async () => {
          await Promise.resolve();
        },
      });
    }
  );
  const cleanups: (() => void)[] = [];
  const { running } = source.connect(
    link,
    bundle,
    () => {
      // Core never refuses the build here.
    },
    cleanups
  );
  running?.((state) => {
    states.push(state);
  });
  const pushVersion = await following.promise;
  /** Core's push of the App's version, once the page has taken it. */
  const pushed = async (push: AppVersionPush): Promise<void> => {
    pushVersion(push);
    // The page asks core about its build in a turn of its own.
    await wait(0);
  };
  return { cleanups, pushed };
};

describe("a page core refuses to open", () => {
  // As the refusal reaches the page over the connection: its code, with
  // core's message, never a reason of the page's own.
  it.each([
    ["page.not_found", "not-found"],
    ["page.unreviewed", "unreviewed"],
    ["version.artifact_corrupt", "corrupt"],
    ["version.manifest_corrupt", "corrupt"],
    ["version.not_sealed", "not-sealed"],
    ["version.revoked", "version-revoked"],
    ["version.nothing_like_this", "unknown"],
  ])("on %s, says it failed as %s", (code, reason) => {
    expect(
      failureOf(Object.assign(new Error("Refused."), { code }))
    ).toStrictEqual(reason);
  });
});

describe("a running page whose App's version core refuses the person", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["role.forbidden", { status: "failed", reason: "forbidden" }],
    ["app.not_found", { status: "failed", reason: "not-found" }],
    ["app.unreadable", { status: "failed", reason: "forbidden" }],
    ["permission.person_inactive", { status: "failed", reason: "forbidden" }],
    [
      "auth.principal_changed",
      { status: "failed", reason: "principal-changed" },
    ],
    ["auth.unauthenticated", { status: "signed-out" }],
  ])("on %s, ends as %o, offering no new version", async (code, ended) => {
    const states: PageState[] = [];
    const { cleanups, pushed } = await runningPage(
      async () => await Promise.resolve("open"),
      states
    );
    await pushed({ type: "refused", error: { code, message: "Refused." } });
    for (const cleanup of cleanups) {
      cleanup();
    }
    // How it ended, without what core said of it (`detail`).
    expect(
      states.map((state) =>
        state.status === "failed"
          ? { status: state.status, reason: state.reason }
          : state
      )
    ).toStrictEqual(ended === undefined ? [] : [ended]);
  });
});

describe("a running page as its App's version changes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a new version gone live once, and nothing for the version it runs", async () => {
    const states: PageState[] = [];
    const { cleanups, pushed } = await runningPage(
      async () => await Promise.resolve("open"),
      states
    );
    await pushed({ type: "current", version: 1, recheck: false });
    const before = [...states];
    await pushed({ type: "current", version: 2, recheck: false });
    await pushed({ type: "current", version: 3, recheck: false });
    for (const cleanup of cleanups) {
      cleanup();
    }
    expect({ before, after: states }).toStrictEqual({
      before: [],
      after: [{ status: "updated" }],
    });
  });

  it("asks core about its build when access may have dropped, and stops once it no longer gets the data", async () => {
    let delivery = "open";
    const refused: string[] = [];
    let pushVersion: ((push: AppVersionPush) => void) | undefined;
    const link = linkAsAda(
      async () => await Promise.resolve(delivery),
      undefined,
      undefined,
      async (_app, onVersion) => {
        pushVersion = onVersion;
        return await Promise.resolve({
          release: async () => {
            await Promise.resolve();
          },
        });
      }
    );
    const cleanups: (() => void)[] = [];
    const { running } = appPage(
      bundle.app,
      confirmNothing,
      confirmNoLink,
      noNavigation
    ).connect(
      link,
      bundle,
      (reason) => {
        refused.push(reason);
      },
      cleanups
    );
    running?.(() => {
      // Only core's refusal of the build matters here.
    });
    await vi.waitFor(() => {
      expect(pushVersion).toBeDefined();
    });
    pushVersion?.({ type: "current", version: 1, recheck: false });
    delivery = "revoked";
    await wait(0);
    const unasked = [...refused];
    pushVersion?.({ type: "current", version: 1, recheck: true });
    await vi.waitFor(() => {
      expect(refused).toStrictEqual(["revoked"]);
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
    expect(unasked).toStrictEqual([]);
  });

  it.each(["page.rate_limited", "page.too_many_subscriptions"])(
    "follows the App again once core's wait for %s is over, never dropping it",
    async (code) => {
      vi.useFakeTimers();
      let asked = 0;
      const link = linkAsAda(
        async () => await Promise.resolve("open"),
        undefined,
        undefined,
        async () => {
          asked += 1;
          if (asked === 1) {
            throw Object.assign(new Error("Wait."), {
              code,
              details: { retryAfterMs: 60_000 },
            });
          }
          return await Promise.resolve({
            release: async () => {
              await Promise.resolve();
            },
          });
        }
      );
      const told: AppVersionPush[] = [];
      const stop = link.followVersion("notes", (push) => {
        told.push(push);
      });
      await vi.advanceTimersByTimeAsync(59_000);
      const early = asked;
      await vi.advanceTimersByTimeAsync(2000);
      stop();
      vi.useRealTimers();
      expect({ early, later: asked, told }).toStrictEqual({
        early: 1,
        later: 2,
        told: [],
      });
    }
  );

  it("shares one subscription of the App among the frames of a tab, the last version told to one that opens later", async () => {
    let followed = 0;
    let pushVersion: ((push: AppVersionPush) => void) | undefined;
    let released = 0;
    const link = linkAsAda(
      async () => await Promise.resolve("open"),
      undefined,
      undefined,
      async (_app, onVersion) => {
        followed += 1;
        pushVersion = onVersion;
        return await Promise.resolve({
          release: async () => {
            released += 1;
            await Promise.resolve();
          },
        });
      }
    );
    const first: AppVersionPush[] = [];
    const second: AppVersionPush[] = [];
    const stopFirst = link.followVersion("notes", (push) => {
      first.push(push);
    });
    await vi.waitFor(() => {
      expect(pushVersion).toBeDefined();
    });
    pushVersion?.({ type: "current", version: 2, recheck: false });
    const stopSecond = link.followVersion("notes", (push) => {
      second.push(push);
    });
    await vi.waitFor(() => {
      expect(second).toHaveLength(1);
    });
    stopFirst();
    const afterFirst = released;
    stopSecond();
    await vi.waitFor(() => {
      expect(released).toBe(1);
    });
    expect({ followed, afterFirst, first, second }).toStrictEqual({
      followed: 1,
      afterFirst: 0,
      first: [{ type: "current", version: 2, recheck: false }],
      second: [{ type: "current", version: 2, recheck: false }],
    });
  });
});

describe("a running page whose query core refuses for its build", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is stopped once core confirms it", async () => {
    let toPage: ((push: unknown) => Promise<unknown>) | undefined;
    let delivery = "open";
    const link = linkAsAda(
      async () => await Promise.resolve(delivery),
      async (_app, _lease, _request, onSnapshot) => {
        toPage = onSnapshot;
        return await Promise.resolve({});
      }
    );
    const source = appPage(
      bundle.app,
      confirmNothing,
      confirmNoLink,
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
      result: { ok: false, error: { code: "page.revoked", message: "No." } },
    });
    await expect(stopped.promise).resolves.toBe("revoked");
    for (const cleanup of cleanups) {
      cleanup();
    }
  });
});

/** Core's refusal `code`, with `status`. */
const refusal = (code: string, status: number): Response =>
  Response.json({ code, message: "Refused." }, { status });

describe("core's answer to a page's file request", () => {
  it("stops the frame for someone else's session, and asks again for its build when refused for it", async () => {
    await expect(
      Promise.all([
        fileRefusal(refusal("auth.principal_changed", 401)),
        fileRefusal(refusal("page.revoked", 403)),
        fileRefusal(refusal("page.unreviewed", 403)),
        fileRefusal(refusal("file.not_found", 404)),
        fileRefusal(Response.json({ code: "page.revoked" })),
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

describe("where in the App a frame is, as the page carries it", () => {
  it("hands the frame the page's address, and moves the page's address a new entry only for the person's own act in the frame", () => {
    const moved: { href: string; push: boolean }[] = [];
    const guards: boolean[] = [];
    const opening: PageOpening = {
      location: {
        current: () => "/notes/n1",
        moved: (href, push) => {
          moved.push({ href, push });
        },
        follow: () => {
          // The page's address doesn't move here.
        },
      },
      leaveGuard: (guarded) => {
        guards.push(guarded);
      },
    };
    const link = linkAsAda(async () => await Promise.resolve("open"));
    const cleanups: (() => void)[] = [];
    // The person acted in the frame once.
    let acts = 1;
    const { target } = appPage(
      bundle.app,
      confirmNothing,
      confirmNoLink,
      opening
    ).connect(
      link,
      bundle,
      () => {
        // Core never refuses the build here.
      },
      cleanups,
      () => {
        acts -= 1;
        return acts >= 0;
      }
    );
    const location = target.location();
    target.navigated("/notes/n2", true);
    // No act left: the App moved on its own, in place of the entry.
    target.navigated("/notes/n3", true);
    target.navigated("/notes/n4", false);
    target.leaveGuard(true);
    for (const cleanup of cleanups) {
      cleanup();
    }
    expect({ location, moved, guards }).toStrictEqual({
      location: "/notes/n1",
      moved: [
        { href: "/notes/n2", push: true },
        { href: "/notes/n3", push: false },
        { href: "/notes/n4", push: false },
      ],
      guards: [true],
    });
  });
});

/** A query's answer of one title. */
const value = (title: string) => ({ ok: true, value: [title] });

/**
 * A preview's target over a core that records what it was asked: each
 * report and the revision it names, each live query its frame follows,
 * with the page's relay of it, which core pushes to; its calls answer
 * `answer` on every page's call path.
 */
const previewOver = (answer: unknown, lease: string | null = "lease") => {
  const reports: string[] = [];
  const watches: { released: boolean }[] = [];
  const calls: { path: string; lease: string | null }[] = [];
  const asked = { reports, watches, calls };
  const relays: ((push: unknown) => Promise<unknown>)[] = [];
  vi.stubGlobal(
    "fetch",
    async (path: string, init: RequestInit): Promise<Response> => {
      asked.calls.push({
        path,
        lease: new Headers(init.headers).get(pageLeaseHeader),
      });
      return await Promise.resolve(Response.json(answer));
    }
  );
  const frameApi = {
    watchQuery: async (
      _request: string,
      relay: (push: unknown) => Promise<unknown>
    ) => {
      const watch = { released: false };
      asked.watches.push(watch);
      relays.push(relay);
      return await Promise.resolve({
        release: async () => {
          watch.released = true;
          await Promise.resolve();
        },
      });
    },
    close: async () => {
      await Promise.resolve();
    },
    [Symbol.dispose]: () => {
      // Nothing held.
    },
  };
  const session = {
    apps: {
      drafts: {
        previewReport: async (
          _app: string,
          revision: number,
          _page: string,
          problem: { kind: string }
        ) => {
          asked.reports.push(`${problem.kind} at ${revision}`);
          await Promise.resolve();
        },
      },
    },
    pages: { frame: async () => await Promise.resolve(frameApi) },
  };
  const link = {
    session: async () => await Promise.resolve(session),
    person: async () => await Promise.resolve("ada"),
  };
  let problems = 0;
  let stale = 0;
  // The revision the frame's reports are of, as its updates say.
  const reporting = { at: 1 };
  // SAFETY: a preview's calls, reports and live queries reach only these
  // of `apps.drafts` and `pages`, which the stand-in has.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
  const asLink = link as unknown as FrameLink;
  const { lease: _bundleLease, ...unleased } = bundle;
  const target = previewTarget(
    asLink,
    { ...unleased, revision: 1, ...(lease === null ? {} : { lease }) },
    atRoot,
    {
      problem: () => {
        problems += 1;
      },
      testDataStale: () => {
        stale += 1;
      },
      followUpdates: () => {
        // The frame's receiver isn't handed over here.
      },
      runningAt: () => reporting.at,
    }
  );
  return {
    target,
    asked,
    relays,
    reporting,
    problems: () => problems,
    stale: () => stale,
  };
};

describe("a preview's frame as its draft changes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts a problem the page reported as one being fixed, but not a library's warning", async () => {
    const { target, asked, problems } = previewOver({ result: { ok: true } });
    await target.report({ kind: "warning", message: "React says" });
    await target.report({ kind: "error", message: "boom" });
    await target.report({ kind: "rejection", message: "nope" });
    expect({ reports: asked.reports, problems: problems() }).toStrictEqual({
      reports: ["warning at 1", "error at 1", "rejection at 1"],
      problems: 2,
    });
  });

  it("names the revision the frame runs as each report arrives, the update it tries included", async () => {
    const { target, asked, reporting } = previewOver({ result: { ok: true } });
    // The frame is trying revision 2: its failure comes before its answer.
    reporting.at = 2;
    const sent = target.report({ kind: "error", message: "The update broke" });
    // Rolled back before core was reached: still the update's.
    reporting.at = 1;
    await sent;
    await target.report({ kind: "error", message: "The page shown broke" });
    expect(asked.reports).toStrictEqual(["error at 2", "error at 1"]);
  });

  it("calls on every page's call path under the preview's lease, and calls nothing without one", async () => {
    const leased = previewOver({ result: { ok: true, value: null } });
    const answered = await leased.target.callFunction("{}");
    const unleased = previewOver({ result: { ok: true } }, null);
    const refused: unknown = await unleased.target.callFunction("{}").then(
      () => "answered",
      (error: unknown) =>
        error instanceof Error ? appErrors.codeOf(error) : undefined
    );
    expect({
      answered,
      calls: leased.asked.calls,
      refused,
      unleasedCalls: unleased.asked.calls,
    }).toStrictEqual({
      answered: { result: { ok: true, value: null } },
      calls: [{ path: "/api/app-functions/notes", lease: "lease" }],
      refused: "app.preview_outdated",
      unleasedCalls: [],
    });
  });

  it("counts a call the draft's own code failed as a problem, and not a refusal that isn't its fault", async () => {
    const failed = previewOver({
      result: { ok: false, error: { code: "contract.invalid_output" } },
    });
    await failed.target.callFunction("{}");
    const refused = previewOver({
      result: { ok: false, error: { code: "role.forbidden" } },
    });
    await refused.target.callFunction("{}");
    expect([failed.problems(), refused.problems()]).toStrictEqual([1, 0]);
  });

  it("says the test data doesn't fit once a call or a live query is refused for it, and not for any other refusal", async () => {
    const misfit = previewOver({
      result: { ok: false, error: { code: "migration.required" } },
    });
    await misfit.target.callFunction("{}");
    const other = previewOver({
      result: { ok: false, error: { code: "contract.invalid_output" } },
    });
    await other.target.callFunction("{}");
    const watched = previewOver({ result: { ok: true } });
    await watched.target.watchQuery(
      "{}",
      new RpcStub(async () => {
        await Promise.resolve();
      })
    );
    await watched.relays[0]?.({
      revision: 1,
      result: { ok: false, error: { code: "migration.backfill_failed" } },
    });
    expect([misfit.stale(), other.stale(), watched.stale()]).toStrictEqual([
      1, 0, 1,
    ]);
  });

  it("hands the frame every data change of a live query across page writes, each numbered past the last it was handed", async () => {
    const { target, relays, reporting } = previewOver({ result: { ok: true } });
    const handed: unknown[] = [];
    await target.watchQuery(
      "{}",
      new RpcStub(async (push: unknown) => {
        handed.push(push);
        await Promise.resolve();
      })
    );
    // Core numbers each subscription's pushes from its own start.
    await relays[0]?.({ revision: 1, result: value("a") });
    await relays[0]?.({ revision: 2, result: value("b") });
    reporting.at = 2;
    target.moved(2);
    await vi.waitFor(() => {
      expect(relays).toHaveLength(2);
    });
    await relays[1]?.({ revision: 1, result: value("b") });
    await relays[1]?.({ revision: 2, result: value("c") });
    reporting.at = 3;
    target.moved(3);
    await vi.waitFor(() => {
      expect(relays).toHaveLength(3);
    });
    await relays[2]?.({ revision: 1, result: value("c") });
    await relays[2]?.({ revision: 2, result: value("d") });
    // Each change reaches the frame numbered past the one before, so its
    // client, which shows only a newer push, shows every one.
    expect(handed).toStrictEqual([
      { revision: 1, result: value("a") },
      { revision: 2, result: value("b") },
      { revision: 3, result: value("b") },
      { revision: 4, result: value("c") },
      { revision: 5, result: value("c") },
      { revision: 6, result: value("d") },
    ]);
  });

  it("follows its live queries again once the frame moves on, letting go of the old ones only then", async () => {
    const { target, asked, relays } = previewOver({ result: { ok: true } });
    const pushes: unknown[] = [];
    await target.watchQuery(
      "{}",
      new RpcStub(async (push: unknown) => {
        pushes.push(push);
        await Promise.resolve();
      })
    );
    target.moved(2);
    await vi.waitFor(() => {
      expect(asked.watches).toStrictEqual([
        { released: true },
        { released: false },
      ]);
    });
    await relays[1]?.({ revision: 4, result: { ok: true, value: [] } });
    // A push of the one let go of reaches nothing.
    await relays[0]?.({ revision: 5, result: { ok: true, value: ["old"] } });
    expect(pushes).toStrictEqual([
      { revision: 4, result: { ok: true, value: [] } },
    ]);
  });
});
