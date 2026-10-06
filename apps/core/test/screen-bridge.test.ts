import { kitModuleName, screenRuntime } from "@grasp-os/compiler";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { removeMember } from "../src/app-members.ts";
import { appHost } from "../src/durable-objects.ts";
import {
  deleteExpired,
  frameAccess,
  stageFrame,
  sweepScreenFrames,
} from "../src/screen-frame.ts";
import { screenCode as buildScreenCode } from "../src/screens.ts";
import { pastAccessRecheck, release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  appModulesOf,
  frameDocument,
  kitModulesOf,
  loadFrame,
  pathOf,
  policyOf,
  routed,
} from "./screen-frames.ts";
import type { Framed } from "./screen-frames.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// What the frontend's screen host reaches for an App's screens, taken from
// the side of the screen: App code nobody reviewed line by line, which the
// page passes on as it is. It tries to call more than its server, as
// someone it isn't, to forge the platform's errors, and to get a way into
// the App or the platform out of a callback. The sample App runs for real.
//
// And it asks and reports without end: a page someone changed passes on
// whatever it likes, on as many connections as it likes, so only what
// core keeps and counts bounds it. Each person's requests and reports of
// an App are counted in the App's own host, the size of a call in bytes.

const idp = mockIdp();

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string };
type Watcher = ((notes: string[]) => Promise<void>) & Disposable & { dup(): Watcher };

export class App extends DurableObject {
  #watchers = new Set<Watcher>();

  whoami(caller: Caller): string {
    return caller.userId;
  }

  chatty(_caller: Caller, note: string): string {
    console.error("could not file", { note });
    for (let line = 1; line <= 25; line += 1) {
      console.log("line", line);
    }
    return "logged";
  }

  notes(): string[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (note TEXT)");
    return this.ctx.storage.sql
      .exec("SELECT note FROM notes")
      .toArray()
      .map((row) => String(row.note));
  }

  addNote(_caller: Caller, note: string): string[] {
    this.notes();
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", note);
    const notes = this.notes();
    for (const watcher of this.#watchers) {
      void this.#send(watcher, notes);
    }
    return notes;
  }

  watchNotes(_caller: Caller, onChange: Watcher): void {
    const watcher = onChange.dup();
    this.#watchers.add(watcher);
    void this.#send(watcher, this.notes());
  }

  watching(): number {
    return this.#watchers.size;
  }

  ignore(_caller: Caller, _onChange: Watcher): string {
    return "not kept";
  }

  async callBoth(
    _caller: Caller,
    first: (value: string) => Promise<void>,
    note: string,
    second: (value: string) => Promise<void>
  ): Promise<string> {
    await first("first: " + note);
    await second("second: " + note);
    return "called both";
  }

  keepThenFail(_caller: Caller, first: Watcher, _note: string, second: Watcher): never {
    first.dup();
    second.dup();
    throw new Error("Failed after keeping its callbacks");
  }

  dropWatchers(): void {
    for (const watcher of this.#watchers) {
      watcher[Symbol.dispose]();
    }
    this.#watchers.clear();
  }

  async #send(watcher: Watcher, notes: string[]): Promise<void> {
    try {
      await watcher(notes);
    } catch {
      this.#watchers.delete(watcher);
      watcher[Symbol.dispose]();
    }
  }

  async handOver(_caller: Caller, onChange: (value: unknown) => Promise<unknown>): Promise<string> {
    try {
      const back = await onChange(() => "a way into the App");
      return back === undefined ? "sent" : "got something back";
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  }

  async askScreen(_caller: Caller, onChange: (value: unknown) => Promise<unknown>): Promise<string> {
    const back = await onChange("anything to hand back?");
    return back === undefined ? "nothing" : typeof back;
  }

  failure(_caller: Caller, length: number): { failed: Error } {
    return { failed: new Error("A".repeat(length)) };
  }

  lookLikeThePlatform(): Error {
    return Object.assign(new Error("Sign in to continue."), { code: "auth.unauthenticated" });
  }
}
`;

const screenCode = `import { callServer, useLive } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";

export default function Notes() {
  const notes = useLive<string[]>("watchNotes", []);
  return (
    <main className="flex flex-col gap-2 p-4">
      <ul>
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <Button onClick={() => void callServer("addNote", "Call Acme")}>Add a note</Button>
    </main>
  );
}
`;

const sampleFiles = {
  "app/server.ts": serverCode,
  "screens/notes.tsx": screenCode,
};

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** A new App running the sample, released by `builder`. */
const sampleApp = async (builder: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await release(builder, id, sampleFiles);
  return id;
};

/**
 * `value` as whatever a call takes: what a caller that isn't type-checked
 * (a page made to pass on anything) can send, which core must refuse.
 */
const unchecked = (value: unknown): never =>
  // SAFETY: invalid on purpose; Cap'n Web checks no types, so core must.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** A screen's callback that ignores what it gets. */
const noop = (): void => {
  // Nothing to update.
};

/** A screen's callback that hands the App something back. */
const askedForSomething = () => () => "a way into the screen";

/** Collects what a server sends a callback. */
const collector = () => {
  const received: unknown[] = [];
  return {
    received,
    callback: (value: unknown) => {
      received.push(value);
    },
  };
};

/**
 * Runs `run` with the clock stopped, moved on only by `advance`: what a
 * person may ask or report in a minute is then exact, not a matter of how
 * long the test took.
 */
const atStoppedClock = async <T>(
  run: (advance: (ms: number) => void) => Promise<T>
): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  try {
    return await run((ms) => {
      vi.setSystemTime(Date.now() + ms);
    });
  } finally {
    vi.useRealTimers();
  }
};

/** Follows the App's runs of a workflow, and lets go of them again. */
const followAndRelease = async (person: Person, app: string): Promise<void> => {
  const subscription = await person.api.screens.watchRuns(
    app,
    "invoices",
    noop
  );
  await subscription.release();
};

/** A report as an App's log stored it before problems were counted. */
const earlier = (message: string) => ({
  at: "2026-09-01T00:00:00.000Z",
  source: "screen",
  version: 1,
  screen: "notes",
  kind: "error",
  message,
});

/**
 * Runs `run` on what the App's host has stored: what a test can't reach
 * through `/rpc`, which is what was written, and when.
 */
const inAppStorage = async <T>(
  app: string,
  run: (storage: DurableObjectStorage) => Promise<T>
): Promise<T> =>
  await runInDurableObject(
    appHost(env, appIdSchema.parse(app)),
    async (_host, state) => await run(state.storage)
  );

/** How many of `outcomes` ended as `code`. */
const ended = (outcomes: string[], code: string): number =>
  outcomes.filter((result) => result === code).length;

/** A value nested `depth` arrays deep. */
const nestedArrays = (depth: number): unknown => {
  let value: unknown = "bottom";
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
};

const minuteMs = 60_000;

const day = 24 * 60 * minuteMs;

/** The rule the closing screen's class makes, `</script>` and all. */
const probeRule = /--probe:\s*'<\/script>'/u;

/** The status core answers `path` with. */
const status = async (path: string): Promise<number> => {
  const response = await routed(path);
  return response.status;
};

/** The status core answers a frame's document with. */
const frameStatus = async (framed: Framed): Promise<number> => {
  const response = await frameDocument(framed);
  return response.status;
};

/** The token an address of an import map carries. */
const tokenOf = (address: string): string =>
  new URL(address).searchParams.get("token") ?? "";

/** An address of an import map without its token. */
const without = (address: string): string => new URL(address).pathname;

/** An address of an import map with `token` in place of its own. */
const withToken = (address: string, token: string): string =>
  `${without(address)}?${new URLSearchParams({ token }).toString()}`;

/** Runs the cron's sweep at `ahead` until it has read everything once. */
const sweptAt = async (ahead: number): Promise<void> => {
  const at = new Date(Date.now() + ahead);
  for (let run = 0; run < 2; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another, as the cron runs
    await sweepScreenFrames(env, at);
  }
};

const waitFor = async <T>(read: () => T | undefined): Promise<T> =>
  await vi.waitFor(() => {
    const value = read();
    if (value === undefined) {
      throw new Error("Not yet");
    }
    return value;
  }, 10_000);

describe("screens", { timeout: 60_000 }, () => {
  it("opens a screen at the App's current version, with only the kit modules it needs", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    const bundle = await builder.api.screens.open(app, "notes");
    const again = await builder.api.screens.open(app, "notes");
    const frame = await loadFrame(bundle);
    if (frame === null) {
      throw new Error("An opened screen has a frame");
    }
    const kit = kitModulesOf(frame);
    expect({
      // Core's own name for the code it hands a frame: the same for the
      // same code, whoever opens it and whenever.
      artifact:
        /^[0-9a-f]{64}$/u.test(bundle.artifact) &&
        again.artifact === bundle.artifact,
      app: bundle.app,
      version: bundle.version,
      frame: frame.screen.artifact,
      runtime: frame.screen.runtime,
      entry: appModulesOf(frame).includes(frame.screen.entry),
      kit: {
        runtime: Object.hasOwn(kit, frame.screen.runtime),
        hooks: Object.hasOwn(kit, kitModuleName("@grasp-os/sdk/screen")),
        button: Object.hasOwn(
          kit,
          kitModuleName("@grasp-os/ui/components/button")
        ),
        unused: Object.hasOwn(
          kit,
          kitModuleName("@grasp-os/ui/components/dialog")
        ),
        empty: Object.values(frame.modules).some((code) => code === ""),
      },
      theme: frame.screen.css.includes("--primary:"),
    }).toStrictEqual({
      artifact: true,
      app,
      version: 1,
      frame: bundle.artifact,
      runtime: kitModuleName(screenRuntime),
      entry: true,
      kit: {
        runtime: true,
        hooks: true,
        button: true,
        unused: false,
        empty: false,
      },
      theme: true,
    });
  });

  it("runs in its frame the modules of the build core opened and no other script", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await builder.api.screens.open(app, "notes");
    const frame = await loadFrame(bundle);
    if (frame === null) {
      throw new Error("An opened screen has a frame");
    }
    const scripts = frame.policy.get("script-src") ?? [];
    // The policy names each address without its token: browsers match a
    // policy's paths without the query.
    const addresses = [
      ...new Set(
        Object.values(frame.addresses).map((address) => {
          const { origin, pathname } = new URL(address);
          return `${origin}${pathname}`;
        })
      ),
    ];
    const unknown = { artifact: "0".repeat(64) };
    const missing = await frameDocument({
      ...unknown,
      frameToken: await frameAccess(env, unknown.artifact),
    });

    expect({
      // The document's own inline scripts by hash, each module of the
      // build by its exact address, and nothing else: no inline script or
      // handler the screen writes, no data: or blob: module, no eval.
      scripts: scripts.toSorted(),
      served: Object.values(frame.addresses).every((address) =>
        new URL(address).pathname.startsWith("/screen-modules/")
      ),
      // A build core never staged runs nothing, and a miss is cached for
      // a minute, not read from storage on every ask.
      missing: {
        status: missing.status,
        scripts: policyOf(missing).get("script-src"),
        cache: missing.headers.get("cache-control"),
      },
    }).toStrictEqual({
      scripts: [...frame.inline, ...addresses].toSorted(),
      served: true,
      missing: {
        status: 404,
        scripts: ["'none'"],
        cache: "public, max-age=60",
      },
    });
  });

  it("serves a frame and its modules only with core's unexpired token for exactly them", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await builder.api.screens.open(app, "notes");
    const frame = await loadFrame(bundle);
    if (frame === null) {
      throw new Error("An opened screen has a frame");
    }
    const [first, second] = Object.values(frame.addresses);
    if (first === undefined || second === undefined) {
      throw new Error("The screen loads modules");
    }
    const frameWith = async (frameToken: string): Promise<number> =>
      await frameStatus({ artifact: bundle.artifact, frameToken });
    const { id: otherApp } = await builder.api.apps.create({ name: "Other" });
    await release(builder, otherApp, {
      ...sampleFiles,
      "screens/notes.tsx": `${screenCode}// another build\n`,
    });
    const other = await builder.api.screens.open(otherApp, "notes");

    const now = {
      frame: await frameWith(bundle.frameToken),
      module: await status(pathOf(first)),
      // A hash alone, a token for something else, a made-up token.
      frameWithout: await frameWith(""),
      frameWithOthers: await frameWith(tokenOf(first)),
      frameMadeUp: await frameWith(`${Date.now() + 60_000}.${"A".repeat(43)}`),
      moduleWithout: await status(without(first)),
      moduleWithOthers: await status(withToken(first, tokenOf(second))),
      moduleWithFrames: await status(withToken(first, bundle.frameToken)),
      anotherBuild: await frameWith(other.frameToken),
    };
    // Expired: the frame's within minutes, a module's within hours.
    const later = await atStoppedClock(async (advance) => {
      advance(11 * 60_000);
      const frameLater = await frameWith(bundle.frameToken);
      const moduleLater = await status(pathOf(first));
      advance(13 * 60 * minuteMs);
      return {
        frame: frameLater,
        module: moduleLater,
        moduleMuchLater: await status(pathOf(first)),
      };
    });

    expect({ now, later }).toStrictEqual({
      now: {
        frame: 200,
        module: 200,
        frameWithout: 403,
        frameWithOthers: 403,
        frameMadeUp: 403,
        moduleWithout: 403,
        moduleWithOthers: 403,
        moduleWithFrames: 403,
        anotherBuild: 403,
      },
      later: { frame: 403, module: 200, moduleMuchLater: 403 },
    });
  });

  it("keeps what a frame is handed inside its own script elements, whatever the CSS holds", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Closing" });
    await release(builder, app, {
      "app/server.ts": serverCode,
      "screens/notes.tsx": `export default function Notes() {
  return <p className="p-2 [--probe:'</script>'] text-sm">Notes</p>;
}
`,
    });
    const bundle = await builder.api.screens.open(app, "notes");
    const response = await frameDocument(bundle);
    const html = await response.text();
    const frame = await loadFrame(bundle);

    expect({
      // Only the document's own three script elements end.
      ends: html.split("</script>").length - 1,
      css: probeRule.test(frame?.screen.css ?? ""),
    }).toStrictEqual({ ends: 3, css: true });
  });

  it("deletes staged builds the cron finds past their days, and stages a build in use again before then", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await builder.api.screens.open(app, "notes");
    const frame = await loadFrame(bundle);
    if (frame === null) {
      throw new Error("An opened screen has a frame");
    }
    const [module] = Object.values(frame.addresses);
    if (module === undefined) {
      throw new Error("The screen loads modules");
    }

    await sweptAt(day);
    const young = {
      frame: await frameStatus(bundle),
      module: await status(pathOf(module)),
    };
    await sweptAt(31 * day);
    const old = {
      frame: await frameStatus(bundle),
      module: await status(pathOf(module)),
    };
    // Opened again, it is staged again and loads.
    const reopened = await loadFrame(
      await builder.api.screens.open(app, "notes")
    );

    // The sweep's race: it lists, an open stages the build again, then
    // the sweep deletes what it listed as old, fresh modules included (R2
    // deletes take no condition). The clock the sweep goes by is moved on,
    // so what was staged again still looks old to it.
    const { artifact, code } = await buildScreenCode(
      env,
      sampleFiles,
      "notes",
      1
    );
    const listedBefore = await env.FILES.list({ prefix: "screen-modules/" });
    await stageFrame(env, artifact, code, new Date(Date.now() + 16 * day));
    await deleteExpired(
      env,
      listedBefore.objects,
      new Date(Date.now() + 31 * day)
    );
    // The frame's document finds its modules gone: it drops its manifest
    // and isn't cached, so the next open stages it all again.
    const raced = await frameDocument(bundle);
    const afterRace = await builder.api.screens.open(app, "notes");
    const healed = await loadFrame(afterRace);
    const healedModule = Object.values(healed?.addresses ?? {})[0] ?? "";

    // A module gone under a fresh manifest is put back at the next open,
    // before any frame asks for it.
    const hash = new URL(module).pathname.split("/").at(-1) ?? "";
    await env.FILES.delete(`screen-modules/${hash}`);
    await builder.api.screens.open(app, "notes");
    const putBack = await status(pathOf(module));

    expect({
      young,
      old,
      reopened: reopened !== null,
      raced: {
        status: raced.status,
        cache: raced.headers.get("cache-control"),
      },
      healed: healed !== null,
      healedModule: await status(pathOf(healedModule)),
      putBack,
    }).toStrictEqual({
      young: { frame: 200, module: 200 },
      old: { frame: 404, module: 404 },
      reopened: true,
      raced: { status: 404, cache: "no-store" },
      healed: true,
      healedModule: 200,
      putBack: 200,
    });
  });

  it("opens only screens the App has, of a current version that builds", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const { id: empty } = await builder.api.apps.create({ name: "Empty" });
    const { id: broken } = await builder.api.apps.create({ name: "Broken" });
    await release(builder, broken, {
      "screens/desk.tsx":
        'import leftPad from "left-pad";\nexport default () => leftPad;\n',
    });

    const refused = await Promise.all([
      outcome(builder.api.screens.open(app, "nope")),
      outcome(builder.api.screens.open(app, "../app/server")),
      outcome(builder.api.screens.open(app, "__proto__")),
      outcome(builder.api.screens.open(empty, "notes")),
      outcome(builder.api.screens.open(broken, "desk")),
      outcome(builder.api.screens.open("no-such-app", "notes")),
    ]);
    expect(refused).toStrictEqual([
      "screen.not_found",
      "screen.invalid",
      "screen.not_found",
      "app.not_running",
      "screen.build_failed",
      "app.not_found",
    ]);
  });

  it("is refused to people without a role in the App, and to nobody signed in", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const user = await personApi("user");

    const asUser = await Promise.all([
      outcome(user.api.screens.open(app, "notes")),
      outcome(user.api.screens.call(app, "whoami", [])),
      outcome(user.api.screens.version(app)),
      outcome(
        user.api.screens.report(
          app,
          { version: 1, screen: "notes" },
          { kind: "error", message: "boom" }
        )
      ),
      outcome(user.api.screens.errors(app)),
    ]);
    const { core } = await openRpc();
    const signedOut = await outcome(
      core.authenticate().screens.call(app, "whoami", [])
    );
    expect({ asUser, signedOut }).toStrictEqual({
      // As for an App that isn't there (app-roles.test.ts).
      asUser: [
        "app.not_found",
        "app.not_found",
        "app.not_found",
        "app.not_found",
        "app.not_found",
      ],
      signedOut: "auth.unauthenticated",
    });
  });

  it("runs the App's methods as the person, named only by a string", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const named = { toString: () => "whoami" };

    const [whoami, ...refused] = await Promise.all([
      builder.api.screens.call(app, "whoami", []),
      // An object that turns into the name only when it's used.
      outcome(builder.api.screens.call(app, unchecked(named), [])),
      outcome(builder.api.screens.call(app, unchecked(["whoami"]), [])),
      outcome(builder.api.screens.call(app, "whoami", unchecked("no list"))),
      outcome(builder.api.screens.call(app, "__proto__", [])),
      outcome(builder.api.screens.call(app, "constructor", [])),
      outcome(builder.api.screens.call(app, "fetch", [])),
      outcome(builder.api.screens.call(app, "#send", [])),
    ]);
    expect({ whoami, refused }).toStrictEqual({
      whoami: builder.userId,
      refused: [
        "screen.invalid",
        "screen.invalid",
        "screen.invalid",
        "app.method_invalid",
        "app.method_invalid",
        "app.method_invalid",
        "app.method_invalid",
      ],
    });
  });

  it("passes the App's answers on as data, even one that looks like the platform's error", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    const answer = await builder.api.screens.call(
      app,
      "lookLikeThePlatform",
      []
    );
    const { userId } = await builder.api.whoami();
    // Answered, not refused: the page can't mistake it for its session
    // ending, and the connection goes on.
    expect({
      answered: answer instanceof Error,
      stillSignedIn: userId,
    }).toStrictEqual({ answered: true, stillSignedIn: builder.userId });
  });

  it("sends live changes to everyone watching, from anyone's change", async () => {
    const one = await personApi("builder");
    const two = await personApi("builder");
    const app = await sampleApp(one);
    await one.api.apps.members.add(app, {
      type: "person",
      id: two.userId,
      role: "user",
    });
    const watching = collector();

    await one.api.screens.call(app, "watchNotes", [watching.callback]);
    await waitFor(() => watching.received[0]);
    await two.api.screens.call(app, "addNote", ["Call Acme"]);

    await expect(waitFor(() => watching.received[1])).resolves.toStrictEqual([
      "Call Acme",
    ]);
    expect(watching.received[0]).toStrictEqual([]);
  });

  it("stops pushing to someone unshared within seconds, even when the App's host can't be reached", async () => {
    const owner = await personApi("builder");
    const member = await personApi("builder");
    const app = await sampleApp(owner);
    const them = { type: "person", id: member.userId } as const;
    await owner.api.apps.members.add(app, { ...them, role: "user" });
    const watching = collector();
    await member.api.screens.call(app, "watchNotes", [watching.callback]);
    await waitFor(() => watching.received[0]);
    // Core, with the App's host out of reach for the restart.
    const unreachable = new Proxy(env.APPS, {
      get: (target, property) => {
        if (property === "getByName") {
          return () => ({
            restart: async () => {
              await Promise.reject(new Error("The App's host is unreachable"));
            },
          });
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const removed = await outcome(
      removeMember(
        { ...env, APPS: unreachable },
        await owner.api.whoami(),
        app,
        them
      )
    );
    // The App wasn't restarted, so it still holds their subscription: the
    // next push after their access was checked again releases it, and the
    // App lets it go.
    const left = await pastAccessRecheck(
      async () =>
        await vi.waitFor(
          async () => {
            await owner.api.screens.call(app, "addNote", ["Meanwhile"]);
            const count = await owner.api.screens.call(app, "watching", []);
            if (count !== 0) {
              throw new Error("Still watching");
            }
            return count;
          },
          { timeout: 3000, interval: 250 }
        )
    );
    const received = watching.received.length;
    await owner.api.screens.call(app, "addNote", ["After it was released"]);
    expect({
      removed,
      left,
      // Nothing more reaches them.
      after: await owner.api.screens.call(app, "watching", []),
      more: watching.received.length - received,
      opens: await outcome(member.api.apps.get(app)),
    }).toStrictEqual({
      removed: "ok",
      left: 0,
      after: 0,
      more: 0,
      opens: "app.not_found",
    });
  });

  it("keeps pushing to Grasp staff while their session holds, and stops once it ends", async () => {
    const owner = await personApi("builder");
    const app = await sampleApp(owner);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const { userId, staff: isStaff } = await staff.whoami();
    const watching = collector();

    // Every push checks their access as the session does, staff window
    // and all: the first, right away, and the next.
    await staff.screens.call(app, "watchNotes", [watching.callback]);
    await waitFor(() => watching.received[0]);
    await owner.api.screens.call(app, "addNote", ["For staff"]);
    const pushed = await waitFor(() => watching.received[1]);

    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
      .bind(userId)
      .run();
    const left = await pastAccessRecheck(
      async () =>
        await vi.waitFor(
          async () => {
            await owner.api.screens.call(app, "addNote", ["After it ended"]);
            const count = await owner.api.screens.call(app, "watching", []);
            if (count !== 0) {
              throw new Error("Still watching");
            }
            return count;
          },
          { timeout: 3000, interval: 250 }
        )
    );
    expect({ isStaff, pushed, left }).toStrictEqual({
      isStaff: true,
      pushed: ["For staff"],
      left: 0,
    });
  });

  it("closes nobody's screens when unsharing someone it isn't shared with", async () => {
    const owner = await personApi("builder");
    const member = await personApi("builder");
    const app = await sampleApp(owner);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const watching = collector();
    await member.api.screens.call(app, "watchNotes", [watching.callback]);
    await waitFor(() => watching.received[0]);

    // Someone it was never shared with, as a mistaken or repeated removal.
    await owner.api.apps.members.remove(app, {
      type: "person",
      id: `user-${crypto.randomUUID()}`,
    });
    await owner.api.screens.call(app, "addNote", ["Still here"]);
    await expect(waitFor(() => watching.received[1])).resolves.toStrictEqual([
      "Still here",
    ]);
  });

  it("stops sending to someone the App is no longer shared with", async () => {
    const owner = await personApi("builder");
    const member = await personApi("builder");
    const app = await sampleApp(owner);
    const them = { type: "person", id: member.userId } as const;
    await owner.api.apps.members.add(app, { ...them, role: "user" });
    const watching = collector();
    await member.api.screens.call(app, "watchNotes", [watching.callback]);
    await waitFor(() => watching.received[0]);

    await owner.api.apps.members.remove(app, them);
    // Unsharing restarted the App, which let go of their subscription.
    const left = await vi.waitFor(async () => {
      const count = await owner.api.screens.call(app, "watching", []);
      if (count !== 0) {
        throw new Error("Still watching");
      }
      return count;
    }, 10_000);
    await owner.api.screens.call(app, "addNote", ["After unsharing"]);
    expect({
      left,
      received: watching.received,
      again: await outcome(
        member.api.screens.call(app, "watchNotes", [watching.callback])
      ),
    }).toStrictEqual({ left: 0, received: [[]], again: "app.not_found" });
  });

  it("stops sending to a screen whose connection ended", async () => {
    const one = await personApi("builder");
    const two = await personApi("builder");
    const app = await sampleApp(one);
    await one.api.apps.members.add(app, {
      type: "person",
      id: two.userId,
      role: "user",
    });
    const watching = collector();
    await one.api.screens.call(app, "watchNotes", [watching.callback]);
    await waitFor(() => watching.received[0]);
    const before = await two.api.screens.call(app, "watching", []);

    one.core[Symbol.dispose]();
    await two.api.screens.call(app, "addNote", ["After it left"]);
    const after = await vi.waitFor(async () => {
      const count = await two.api.screens.call(app, "watching", []);
      if (count !== 0) {
        throw new Error("Still watching");
      }
      return count;
    }, 10_000);
    expect({ before, after, received: watching.received }).toStrictEqual({
      before: 1,
      after: 0,
      received: [[]],
    });
  });

  it("takes a screen's callbacks in any argument, and keeps as many as its App holds", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    // With the calls around them, within what one person may ask at once.
    const many = 15;

    const ignored = await builder.api.screens.call(app, "ignore", [noop, noop]);
    // Two callbacks, in two places around plain data, each reaching the
    // screen with what the App sent it.
    const first = collector();
    const second = collector();
    const calledBoth = await builder.api.screens.call(app, "callBoth", [
      first.callback,
      "hello",
      second.callback,
    ]);
    await Promise.all(
      Array.from(
        { length: many },
        async () => await builder.api.screens.call(app, "watchNotes", [noop])
      )
    );
    expect({
      ignored,
      calledBoth,
      first: first.received,
      second: second.received,
      watching: await builder.api.screens.call(app, "watching", []),
    }).toStrictEqual({
      ignored: "not kept",
      calledBoth: "called both",
      first: ["first: hello"],
      second: ["second: hello"],
      watching: many,
    });
  });

  it("frees a connection's callbacks as its Apps let them go", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    let released = 0;
    // A screen's callback that notes when core lets go of it.
    const tracked = () =>
      Object.assign(
        (): void => {
          // Nothing to update.
        },
        {
          [Symbol.dispose]: () => {
            released += 1;
          },
        }
      );
    const half = 8;
    const call = async (method: string) =>
      await outcome(builder.api.screens.call(app, method, [tracked()]));

    // Half go to a method that doesn't keep them, half are kept and then
    // dropped by the App: all of them are released.
    const notKept = await Promise.all(
      Array.from({ length: half }, async () => await call("ignore"))
    );
    const keptThenDropped = await Promise.all(
      Array.from({ length: half }, async () => await call("watchNotes"))
    );
    await builder.api.screens.call(app, "dropWatchers", []);
    // A call that fails after its App kept both its callbacks, passed in
    // two places: core releases both.
    const failed = await outcome(
      builder.api.screens.call(app, "keepThenFail", [
        tracked(),
        "note",
        tracked(),
      ])
    );
    const expected = 2 * half + 2;
    await vi.waitFor(() => {
      if (released < expected) {
        throw new Error(`${released} released so far`);
      }
    }, 10_000);

    expect({
      notKept: notKept.every((result) => result === "ok"),
      keptThenDropped: keptThenDropped.every((result) => result === "ok"),
      failed,
      released,
    }).toStrictEqual({
      notKept: true,
      keptThenDropped: true,
      failed: "app.failed",
      released: expected,
    });
  });

  it("never hands a screen a way into the App, or the App one back", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const handedOver = collector();

    const [handOver, askScreen] = await Promise.all([
      builder.api.screens.call(app, "handOver", [handedOver.callback]),
      builder.api.screens.call(app, "askScreen", [askedForSomething]),
    ]);
    const nested = await outcome(
      builder.api.screens.call(app, "whoami", [{ callback: () => "nested" }])
    );
    expect({
      handOver,
      received: handedOver.received,
      askScreen,
      nested,
    }).toStrictEqual({
      handOver: "app.answer_invalid",
      received: [],
      askScreen: "nothing",
      nested: "screen.invalid",
    });
  });

  it("follows the App's current version", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const before = await builder.api.screens.version(app);
    await release(builder, app, {
      "screens/notes.tsx": `${screenCode}// v2\n`,
    });
    expect({
      before,
      after: await builder.api.screens.version(app),
    }).toStrictEqual({ before: 1, after: 2 });
  });

  it("keeps the newest problems a screen reports in the App's error log, held to size", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const at = { version: 1, screen: "notes" };
    await builder.api.screens.report(app, at, {
      kind: "error",
      message: "Invoice 7 has no total",
      stack: "at Notes (app~screens~notes.js:3:9)",
    });
    await builder.api.screens.report(app, at, {
      kind: "console",
      message: "x".repeat(10_000),
    });
    const refused = await Promise.all([
      outcome(
        builder.api.screens.report(
          app,
          at,
          unchecked({ kind: "alert", message: "not a kind" })
        )
      ),
      outcome(
        builder.api.screens.report(
          app,
          at,
          unchecked({ kind: "error", message: "x", userId: "someone-else" })
        )
      ),
      outcome(
        builder.api.screens.report(
          app,
          { version: 0, screen: "notes" },
          { kind: "error", message: "no such version" }
        )
      ),
      outcome(
        builder.api.screens.report(
          app,
          { version: 99, screen: "notes" },
          { kind: "error", message: "a version the App never had" }
        )
      ),
    ]);

    const { entries, suppressed } = await builder.api.screens.errors(app);
    const [newest, oldest, ...rest] = entries;
    expect({
      suppressed,
      newest,
      oldest,
      rest,
      refused,
      dated: !Number.isNaN(Date.parse(oldest?.at ?? "")),
    }).toMatchObject({
      suppressed: 0,
      dated: true,
      newest: {
        source: "screen",
        kind: "console",
        version: 1,
        screen: "notes",
        message: "x".repeat(2000),
        count: 1,
      },
      oldest: {
        kind: "error",
        message: "Invoice 7 has no total",
        stack: "at Notes (app~screens~notes.js:3:9)",
      },
      rest: [],
      refused: [
        "screen.invalid",
        "screen.invalid",
        "screen.invalid",
        "app.version_not_found",
      ],
    });
  });

  it("keeps what the App's server code writes with console, the first lines of each call, counted", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const called = await builder.api.screens.call(app, "chatty", ["invoice 7"]);
    await vi.waitFor(
      async () => {
        const { entries } = await builder.api.screens.errors(app);
        expect(entries).toHaveLength(20);
      },
      { timeout: 10_000, interval: 50 }
    );
    // The same lines again: counted on the entries they match.
    await builder.api.screens.call(app, "chatty", ["invoice 7"]);
    const { entries, suppressed } = await vi.waitFor(
      async () => {
        const log = await builder.api.screens.errors(app);
        expect(log.entries.every(({ count }) => count === 2)).toBeTruthy();
        return log;
      },
      { timeout: 10_000, interval: 50 }
    );
    const undated = entries.map(({ at: _at, ...entry }) => entry);
    expect({
      called,
      kept: entries.length,
      suppressed,
      newest: undated[0],
      oldest: undated.at(-1),
      dated: entries.every(({ at }) => !Number.isNaN(Date.parse(at))),
    }).toStrictEqual({
      called: "logged",
      kept: 20,
      suppressed: 0,
      dated: true,
      newest: {
        source: "server",
        version: 1,
        method: "chatty",
        level: "log",
        message: "line 19",
        count: 2,
      },
      // What the App wrote, with its method and time: never who called.
      oldest: {
        source: "server",
        version: 1,
        method: "chatty",
        level: "error",
        message: 'could not file {"note":"invoice 7"}',
        count: 2,
      },
    });
  });

  it("keeps only the newest hundred different problems", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const log = await atStoppedClock(async (advance) => {
      for (let count = 1; count <= 101; count += 1) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await builder.api.screens.report(
          app,
          { version: 1, screen: "notes" },
          { kind: "error", message: `Problem ${count}` }
        );
        // Twenty a minute is all one person's screens may report.
        if (count % 20 === 0) {
          advance(minuteMs);
        }
      }
      return await builder.api.screens.errors(app);
    });
    expect({
      entries: log.entries.length,
      newest: log.entries[0]?.message,
      oldest: log.entries.at(-1)?.message,
      suppressed: log.suppressed,
    }).toStrictEqual({
      entries: 100,
      newest: "Problem 101",
      oldest: "Problem 2",
      suppressed: 0,
    });
  });

  it("keeps the reports an App already has, and numbers the next after them", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    // As an App's log was stored before problems were counted: numbered
    // from a count under `error-log-count`.
    await inAppStorage(app, async (storage) => {
      await storage.put({
        "error-log-count": 7,
        "error-log:000000000006": earlier("An older problem"),
        "error-log:000000000007": earlier("An old problem"),
      });
    });

    await builder.api.screens.report(
      app,
      { version: 1, screen: "notes" },
      { kind: "error", message: "A new problem" }
    );
    await builder.api.screens.report(
      app,
      { version: 1, screen: "notes" },
      { kind: "error", message: "An older problem" }
    );

    const { entries } = await builder.api.screens.errors(app);
    expect({
      entries: entries.map(({ message, count }) => ({ message, count })),
      stored: await inAppStorage(app, async (storage) => {
        const kept = await storage.list({ prefix: "error-log:" });
        return [...kept.keys()];
      }),
    }).toStrictEqual({
      entries: [
        // Seen again: once more of the entry it had, now the newest.
        { message: "An older problem", count: 1 },
        { message: "A new problem", count: 1 },
        { message: "An old problem", count: undefined },
      ],
      stored: [
        "error-log:000000000007",
        "error-log:000000000008",
        "error-log:000000000009",
      ],
    });
  });

  it("writes the count of dropped reports once a minute at most, however often the log is read, and reads all of them", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const at = { version: 1, screen: "notes" };
    const report = async (): Promise<string> =>
      await outcome(
        builder.api.screens.report(app, at, {
          kind: "error",
          message: "Rendered too often",
        })
      );
    const stored = async (): Promise<number | undefined> =>
      await inAppStorage(
        app,
        async (storage) => await storage.get<number>("error-log-suppressed")
      );

    const result = await atStoppedClock(async (advance) => {
      for (let kept = 0; kept < 20; kept += 1) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await report();
      }
      // The first one dropped is written at once; the rest of the minute
      // are only counted, read or not.
      const read: number[] = [];
      const written: (number | undefined)[] = [];
      for (let dropped = 0; dropped < 6; dropped += 1) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await report();
        // oxlint-disable-next-line no-await-in-loop -- in order
        const log = await builder.api.screens.errors(app);
        read.push(log.suppressed);
        // oxlint-disable-next-line no-await-in-loop -- in order
        written.push(await stored());
      }
      // A minute on, the person may report twenty more, and the next
      // one dropped writes what was counted meanwhile.
      advance(minuteMs);
      for (let later = 0; later < 21; later += 1) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await report();
      }
      const log = await builder.api.screens.errors(app);
      return {
        read,
        written,
        readLater: log.suppressed,
        writtenLater: await stored(),
      };
    });

    expect(result).toStrictEqual({
      read: [1, 2, 3, 4, 5, 6],
      written: [1, 1, 1, 1, 1, 1],
      readLater: 7,
      writtenLater: 7,
    });
  });

  it("keeps the same problem once, counted, as the newest", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const at = { version: 1, screen: "notes" };
    const loop = { kind: "error", message: "Rendered too often" } as const;
    for (const problem of [
      loop,
      loop,
      { kind: "error", message: "Invoice 7 has no total" } as const,
      loop,
      // The same words from elsewhere are another problem.
      { ...loop, stack: "at Notes (app~screens~notes.js:3:9)" },
      { ...loop, kind: "console" } as const,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await builder.api.screens.report(app, at, problem);
    }

    const { entries } = await builder.api.screens.errors(app);
    expect(
      entries.map((entry) =>
        entry.source === "screen"
          ? {
              kind: entry.kind,
              message: entry.message,
              stack: entry.stack,
              count: entry.count,
            }
          : entry
      )
    ).toStrictEqual([
      { kind: "console", message: loop.message, stack: undefined, count: 1 },
      {
        kind: "error",
        message: loop.message,
        stack: "at Notes (app~screens~notes.js:3:9)",
        count: 1,
      },
      { kind: "error", message: loop.message, stack: undefined, count: 3 },
      {
        kind: "error",
        message: "Invoice 7 has no total",
        stack: undefined,
        count: 1,
      },
    ]);
  });

  it("keeps twenty of one person's flood of reports a minute, on any number of connections, and counts the rest in one number", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const at = { version: 1, screen: "notes" };
    // The same person again, on a connection of their own: a second tab,
    // or a page changed to open more.
    const second = await openRpc(builder.session);
    const connections = [builder.api, second.core.authenticate()];

    const result = await atStoppedClock(async (advance) => {
      const flood = await Promise.all(
        Array.from(
          { length: 300 },
          async (_value, index) =>
            await outcome(
              connections[index % 2]?.screens.report(app, at, {
                kind: "error",
                message: `Problem ${index}`,
              }) ?? Promise.resolve()
            )
        )
      );
      const afterFlood = await builder.api.screens.errors(app);
      advance(minuteMs);
      const nextMinute = await Promise.all(
        Array.from(
          { length: 30 },
          async (_value, index) =>
            await outcome(
              builder.api.screens.report(app, at, {
                kind: "error",
                message: `Later problem ${index}`,
              })
            )
        )
      );
      return {
        flood,
        afterFlood,
        nextMinute,
        afterNextMinute: await builder.api.screens.errors(app),
      };
    });

    expect({
      kept: ended(result.flood, "ok"),
      refused: ended(result.flood, "screen.rate_limited"),
      entries: result.afterFlood.entries.length,
      suppressed: result.afterFlood.suppressed,
      keptNextMinute: ended(result.nextMinute, "ok"),
      entriesNextMinute: result.afterNextMinute.entries.length,
      suppressedNextMinute: result.afterNextMinute.suppressed,
    }).toStrictEqual({
      kept: 20,
      refused: 280,
      entries: 20,
      suppressed: 280,
      keptNextMinute: 20,
      entriesNextMinute: 40,
      suppressedNextMinute: 290,
    });
  });

  it("counts a report that says nothing valid against what a screen may report", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const at = { version: 1, screen: "notes" };

    const result = await atStoppedClock(async () => {
      const malformed = await Promise.all(
        Array.from(
          { length: 20 },
          async (_value, index) =>
            await outcome(
              builder.api.screens.report(
                app,
                index % 2 === 0 ? at : unchecked({ version: "one" }),
                unchecked({ kind: "alert", message: "not a kind", index })
              )
            )
        )
      );
      const valid = await outcome(
        builder.api.screens.report(app, at, {
          kind: "error",
          message: "Invoice 7 has no total",
        })
      );
      return { malformed, valid, log: await builder.api.screens.errors(app) };
    });

    expect({
      invalid: ended(result.malformed, "screen.invalid"),
      valid: result.valid,
      log: result.log,
    }).toStrictEqual({
      invalid: 20,
      valid: "screen.rate_limited",
      log: { entries: [], suppressed: 1 },
    });
  });

  it("keeps two hundred reports a minute of an App's screens, whoever sends them", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const at = { version: 1, screen: "notes" };
    const problem = { kind: "error", message: "Rendered too often" } as const;
    const people = [builder];
    for (let person = 0; person < 10; person += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one sign-in at a time
      const user = await personApi("user");
      // oxlint-disable-next-line no-await-in-loop -- one sign-in at a time
      await builder.api.apps.members.add(app, {
        type: "person",
        id: user.userId,
        role: "user",
      });
      people.push(user);
    }

    const result = await atStoppedClock(async () => {
      // Each within what one person may report: twenty.
      const reports = await Promise.all(
        people.flatMap(({ api }) =>
          Array.from(
            { length: 20 },
            async () => await outcome(api.screens.report(app, at, problem))
          )
        )
      );
      return { reports, log: await builder.api.screens.errors(app) };
    });

    expect({
      kept: ended(result.reports, "ok"),
      refused: ended(result.reports, "screen.rate_limited"),
      entries: result.log.entries.map(({ count }) => count),
      suppressed: result.log.suppressed,
    }).toStrictEqual({
      kept: 200,
      refused: 20,
      entries: [200],
      suppressed: 20,
    });
  });

  it("answers a burst of one person's requests of an App, refuses the rest, and another person's none", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const other = await personApi("user");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const second = await openRpc(builder.session);
    const connections = [builder.api, second.core.authenticate()];

    const result = await atStoppedClock(async (advance) => {
      const flood = await Promise.all(
        Array.from({ length: 60 }, async (_value, index) => {
          const screens =
            connections[index % 2]?.screens ?? builder.api.screens;
          // Every kind of request counts, the refused and malformed too.
          if (index % 3 === 0) {
            return await outcome(screens.call(app, "whoami", []));
          }
          if (index % 3 === 1) {
            return await outcome(screens.call(app, unchecked({}), []));
          }
          return await outcome(screens.runs(app, "no-such-workflow"));
        })
      );
      const others = await outcome(other.api.screens.call(app, "whoami", []));
      // Two a second.
      advance(1000);
      const later = await Promise.all(
        [0, 0, 0].map(
          async () => await outcome(builder.api.screens.call(app, "whoami", []))
        )
      );
      return { flood, others, later };
    });

    expect({
      admitted: 60 - ended(result.flood, "screen.rate_limited"),
      others: result.others,
      later: result.later.toSorted(),
    }).toStrictEqual({
      admitted: 20,
      others: "ok",
      later: ["ok", "ok", "screen.rate_limited"],
    });
  });

  it("holds a call's arguments and answer to their size in bytes, not characters", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const add = async (note: string): Promise<string> =>
      await outcome(builder.api.screens.call(app, "addNote", [note]));

    const results = {
      // 120,000 bytes: within the 128 KiB a call may send.
      ascii: await add("a".repeat(120_000)),
      // Fewer characters, but three bytes each: 150,000 bytes.
      euros: await add("€".repeat(50_000)),
      // The App answers every note: 240,000 bytes, within 256 KiB.
      second: await add("b".repeat(120_000)),
      // And now 360,000.
      third: await add("c".repeat(120_000)),
      read: await outcome(builder.api.screens.call(app, "notes", [])),
    };

    expect(results).toStrictEqual({
      ascii: "ok",
      euros: "screen.input_too_large",
      second: "ok",
      third: "screen.answer_too_large",
      read: "screen.answer_too_large",
    });
  });

  it("counts an error by the message it carries, sent or answered", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const call = async (method: string, argument: unknown): Promise<string> =>
      await outcome(builder.api.screens.call(app, method, [argument]));

    // As JSON an error is "{}"; over the connection it is its message.
    expect({
      smallSent: await call("whoami", new Error("small")),
      bigSent: await call("whoami", new Error("A".repeat(200_000))),
      bigSentInside: await call("whoami", {
        deep: [new Error("A".repeat(200_000))],
      }),
      smallAnswered: await call("failure", 10),
      bigAnswered: await call("failure", 300_000),
    }).toStrictEqual({
      smallSent: "ok",
      bigSent: "screen.input_too_large",
      bigSentInside: "screen.input_too_large",
      smallAnswered: "ok",
      bigAnswered: "screen.answer_too_large",
    });
  });

  it("holds what an App pushes a screen to the size of an answer, and drops the callback it refused", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const watching = collector();
    await builder.api.screens.call(app, "watchNotes", [watching.callback]);
    const sizes = (): number[] =>
      watching.received.map((notes) => JSON.stringify(notes).length);

    // Each note is pushed with all before it: 120,000 bytes, 240,000,
    // then 360,000, which is more than a screen takes.
    for (const letter of ["a", "b", "c"]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await outcome(
        builder.api.screens.call(app, "addNote", [letter.repeat(120_000)])
      );
    }
    // Asked slowly enough to stay within what a person may ask.
    await vi.waitFor(
      async () => {
        expect({
          watching: await builder.api.screens.call(app, "watching", []),
          pushes: watching.received.length,
        }).toStrictEqual({ watching: 0, pushes: 3 });
      },
      { timeout: 10_000, interval: 500 }
    );

    expect(sizes().map((size) => size > 256 * 1024)).toStrictEqual([
      false,
      false,
      false,
    ]);
  });

  it("counts following an App's runs as a request, however often a screen lets go again", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    const followed = await atStoppedClock(async () => {
      const results: string[] = [];
      for (let attempt = 0; attempt < 25; attempt += 1) {
        // Let go at once, so never near the twenty a screen may hold.
        // oxlint-disable-next-line no-await-in-loop -- follow, let go, follow again
        results.push(await outcome(followAndRelease(builder, app)));
      }
      return results;
    });

    expect({
      followed: ended(followed, "ok"),
      refused: ended(followed, "screen.rate_limited"),
    }).toStrictEqual({ followed: 20, refused: 5 });
  });

  it("ends a connection that sends a value nested deeper than a screen's may be", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const attacker = await openRpc(builder.session);

    const shallow = await outcome(
      builder.api.screens.call(app, "whoami", [nestedArrays(20)])
    );
    const deep = await outcome(
      attacker.core
        .authenticate()
        .screens.call(app, "whoami", [nestedArrays(40)])
    );

    expect({
      shallow,
      deepAnswered: deep === "ok",
      // Only the connection that sent it ends.
      after: await outcome(builder.api.screens.call(app, "whoami", [])),
    }).toStrictEqual({ shallow: "ok", deepAnswered: false, after: "ok" });
  });
});
