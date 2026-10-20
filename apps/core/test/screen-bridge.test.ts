import { kitModuleName, screenRuntime } from "@grasp-os/compiler";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import {
  deleteExpired,
  frameAccess,
  stageFrame,
  sweepScreenFrames,
} from "../src/screen-frame.ts";
import { ScreenFrameRpc, ScreensRpc } from "../src/screens-rpc.ts";
import { screenCode as buildScreenCode } from "../src/screens.ts";
import { release } from "./apps.ts";
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
import type { RawSettled } from "./sign-in.ts";
import { openRawRpc, openRpc, outcome, signedInApi } from "./sign-in.ts";

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

  echo(_caller: Caller, value: unknown): unknown {
    return value;
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

const screenCode = `import { useWorkflow } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";

export default function Notes() {
  const { runs } = useWorkflow("notes");
  return (
    <main className="flex flex-col gap-2 p-4">
      <p>{runs.length} runs</p>
      <Button>Add a note</Button>
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
  const subscription = await person.api.screens
    .frame(app, "")
    .watchRuns("invoices", noop);
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

/** `nestedArrays(depth)` as Cap'n Web writes it: each array as `[[...]]`. */
const wireArrays = (depth: number): unknown => {
  let value: unknown = "bottom";
  for (let level = 1; level < depth; level += 1) {
    value = [[value]];
  }
  return value;
};

/** Whether `value` is an object with a `code`, as an error's own properties travel. */
const isCoded = (value: unknown): value is { code: unknown } =>
  typeof value === "object" && value !== null && "code" in value;

/**
 * How a raw call settled: what it answered, or the code of its error
 * (Cap'n Web writes one as `["error", name, message, stack?, own]`).
 */
const rawOutcome = ([kind, , value]: RawSettled): unknown => {
  if (kind === "resolve") {
    return { answered: value };
  }
  const own = Array.isArray(value) ? value.find(isCoded) : undefined;
  return own?.code ?? value;
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

  it("serves a module to its frame, never to the product page's own request for it", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await builder.api.screens.open(app, "notes");
    const frame = await loadFrame(bundle);
    const [address] = Object.values(frame?.addresses ?? {});
    if (address === undefined) {
      throw new Error("The screen loads modules");
    }
    const asked = async (site?: string) => {
      const response = await routed(
        pathOf(address),
        site === undefined ? {} : { "sec-fetch-site": site }
      );
      return [response.status, response.headers.get("vary")];
    };

    // The frame's origin is opaque, so a browser calls its requests
    // cross-site; the product page's own are same-origin, valid token or
    // not. A request that says nothing (an older browser) still has its
    // token checked. Each answer varies on the header, so the copy the
    // frame's load left in the browser's cache never answers the page.
    expect({
      frame: await asked("cross-site"),
      productPage: await asked("same-origin"),
      sameSite: await asked("same-site"),
      unsaid: await asked(),
    }).toStrictEqual({
      frame: [200, "sec-fetch-site"],
      productPage: [403, "sec-fetch-site"],
      sameSite: [200, "sec-fetch-site"],
      unsaid: [200, "sec-fetch-site"],
    });
  });

  it("answers no module at an address under the frontend's own files, however it is escaped", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await builder.api.screens.open(app, "notes");
    const frame = await loadFrame(bundle);
    const [address] = Object.values(frame?.addresses ?? {});
    if (address === undefined) {
      throw new Error("The screen loads modules");
    }
    // The product page's policy allows anything under /assets/, matched
    // as the browser writes the path; decoded, each of these is the
    // module's own address. Asked as the product page would ask.
    const escapes = ["..%2F", "..%2f", "..%5C", "%2E%2E%2F", "x/..%2F..%2F"];
    const answers = await Promise.all(
      escapes.map(async (escape) => {
        const response = await routed(
          pathOf(address).replace(
            "/screen-modules/",
            `/assets/${escape}screen-modules/`
          ),
          { "sec-fetch-site": "same-origin", "sec-fetch-dest": "script" }
        );
        return [response.status, await response.text()] as const;
      })
    );
    const served = await routed(pathOf(address));
    const code = await served.text();
    expect(served.status).toBe(200);

    expect(answers.map(([answered]) => answered)).toStrictEqual(
      escapes.map(() => 404)
    );
    expect(answers.filter(([, body]) => body === code)).toStrictEqual([]);
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

  it("says the page's language in a frame's document, only one the page speaks, and English otherwise", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await builder.api.screens.open(app, "notes");
    const langOf = async (lang?: string): Promise<string | undefined> => {
      const response = await frameDocument(
        bundle,
        lang === undefined ? {} : { lang }
      );
      return /<html lang="(?<lang>[^"]*)">/u.exec(await response.text())?.groups
        ?.lang;
    };
    expect({
      german: await langOf("de"),
      french: await langOf("fr"),
      unknown: await langOf("ja"),
      injected: await langOf('de"><script>'),
      none: await langOf(),
    }).toStrictEqual({
      german: "de",
      french: "fr",
      unknown: "en",
      injected: "en",
      none: "en",
    });
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
      1,
      "app-test"
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

  it("refuses a value built from many messages deeper than values may be, before any of core's code runs, and passes one as deep", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const raw = await openRawRpc(builder.session);
    const session = raw.push(["pipeline", 0, ["authenticate"], []]);
    const frame = raw.push([
      "pipeline",
      session,
      ["screens", "frame"],
      [app, ""],
    ]);
    // A value `base` levels deep, then `levels` more pushes, each an array
    // around the push before: no message is deeper than `base`.
    const built = (base: number, levels: number): number => {
      let pushed = raw.push(wireArrays(base));
      for (let level = 0; level < levels; level += 1) {
        pushed = raw.push([[["pipeline", pushed]]]);
      }
      return pushed;
    };
    const echoed = async (pushed: number): Promise<unknown> =>
      rawOutcome(
        await raw.pull(
          raw.push([
            "pipeline",
            frame,
            ["startRun"],
            ["missing", ["pipeline", pushed]],
          ])
        )
      );

    // A run's input, passed straight: one level deeper than values nest
    // gets in (screen-limits.ts, `rpcArgumentDepth`), to core's own code.
    const deepest = await echoed(built(valueDepth - 8, 9));
    const oneMore = await echoed(built(valueDepth - 8, 10));
    // Thousands of levels: refused as such, not by running out of stack.
    const farDeeper = await echoed(built(30, 100));
    const after = await echoed(built(1, 0));
    raw.close();

    expect({ deepest, oneMore, farDeeper, after }).toStrictEqual({
      // Past the connection's checks, refused by core's own code.
      deepest: "workflow.not_found",
      // Core's own code would have said `screen.invalid`.
      oneMore: "request.too_deep",
      farDeeper: "request.too_deep",
      // The connection goes on.
      after: "workflow.not_found",
    });
  });

  it("serves no call of an App's server, on the connection or a frame of it", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const raw = await openRawRpc(builder.session);
    const session = raw.push(["pipeline", 0, ["authenticate"], []]);
    const called = rawOutcome(
      await raw.pull(
        raw.push([
          "pipeline",
          session,
          ["screens", "call"],
          [app, "addNote", [["Call Acme"]]],
        ])
      )
    );
    raw.close();

    expect({
      called:
        typeof called === "object" && called !== null && "answered" in called,
      connection: "call" in ScreensRpc.prototype,
      frame: "call" in ScreenFrameRpc.prototype,
    }).toStrictEqual({ called: false, connection: false, frame: false });
  });

  it("refuses a value a key every object has carries in, a prototype and an error's own among them", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const raw = await openRawRpc(builder.session);
    const session = raw.push(["pipeline", 0, ["authenticate"], []]);
    const frame = raw.push([
      "pipeline",
      session,
      ["screens", "frame"],
      [app, ""],
    ]);
    // A value 30 levels deep, then 100 pushes each an array around the last.
    let deep = raw.push(wireArrays(30));
    for (let level = 0; level < 100; level += 1) {
      deep = raw.push([[["pipeline", deep]]]);
    }
    const shallow = raw.push({ approved: true });
    // `{ [key]: <a pushed value> }` as a run's input: Cap'n Web
    // puts the value in place under the key once the message is checked.
    const echoed = async (key: string, pushed: number): Promise<unknown> =>
      rawOutcome(
        await raw.pull(
          raw.push([
            "pipeline",
            frame,
            ["startRun"],
            ["missing", { [key]: ["pipeline", pushed] }],
          ])
        )
      );

    const outcomes = {
      // Its prototype is then the value: refused however shallow.
      protoDeep: await echoed("__proto__", deep),
      protoShallow: await echoed("__proto__", shallow),
      constructorDeep: await echoed("constructor", deep),
      toJSONDeep: await echoed("toJSON", deep),
      // As text: equality compares a `constructor` key as the class.
      constructorShallow: JSON.stringify(await echoed("constructor", shallow)),
      // Cap'n Web gives it `errors` as a property `Object.keys` skips.
      aggregateDeep: rawOutcome(
        await raw.pull(
          raw.push([
            "pipeline",
            frame,
            ["startRun"],
            [
              "missing",
              [
                "error",
                "AggregateError",
                "m",
                null,
                { errors: ["pipeline", deep] },
              ],
            ],
          ])
        )
      ),
    };
    raw.close();

    expect(outcomes).toStrictEqual({
      protoDeep: "request.unsupported_value",
      protoShallow: "request.unsupported_value",
      constructorDeep: "request.too_deep",
      toJSONDeep: "request.too_deep",
      // Past the connection's checks, refused by core's own code.
      constructorShallow: JSON.stringify("workflow.not_found"),
      aggregateDeep: "request.too_deep",
    });
  });
});
