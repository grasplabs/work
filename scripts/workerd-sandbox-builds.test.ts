/**
 * The package builder on the on-prem sandbox, on plain workerd: a
 * stand-in core (apps/core/test/workerd/builds-worker.ts) runs the same
 * `packageBuilder` a resolve and a build run, with `SANDBOX_HOST` bound to
 * the supervisor (workerd-sandbox.ts) and the builder core's build makes.
 * Plain workerd ignores an isolate's CPU limit, so a package that holds
 * or exhausts the builder must never run in core's own process. (The
 * screen compiler's own on-prem tests are core's test/on-prem/builds.test.ts.)
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp, tempDir } from "./workerd-test-server.ts";

const repo = path.join(import.meta.dirname, "..");

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

/**
 * How long a builder's call may take on the sandbox host here: longer than
 * a session waits for its owner's room (3 s), so a second call gives up
 * waiting while the first still holds the owner's share.
 */
const DEADLINE_MS = 6000;

const outcomeSchema = z.object({
  status: z.enum(["ok", "bound", "unavailable", "failed"]),
  value: z.unknown().optional(),
  error: z.string().optional(),
  httpStatus: z.number().nullable().optional(),
  ms: z.number(),
});

const builtFileSchema = z.object({
  bytes: z.number(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

/** What the stand-in says of each file a build returned. */
const builtFilesSchema = z
  .array(
    z.object({
      path: z.string(),
      described: builtFileSchema,
      returned: builtFileSchema,
      holdsExport: z.boolean(),
    })
  )
  .min(1);

const inspectionsSchema = z.array(
  z.object({ key: z.string(), refusals: z.array(z.string()).optional() })
);

describe("the package builder on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;
  /** A pool of four, so the builder's share is two: one each for two Apps. */
  let wide: SandboxSupervisor;
  let wideUrl: string;
  /** A second core isolate on that pool: core takes one App's builds in turns only within an isolate. */
  let otherUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      log: () => {},
    });
    // The builder as core's build makes it, esbuild and all.
    const assets = tempDir();
    execFileSync(
      process.execPath,
      [
        path.join(repo, "packages/compiler/build.ts"),
        assets,
        path.join(assets, "version.ts"),
      ],
      { cwd: path.join(repo, "packages/compiler"), stdio: "ignore" }
    );
    const [release] = readdirSync(path.join(assets, "_compiler"));
    const built = path.join(assets, "_compiler", release ?? "");
    const standIn = async (socket: string): Promise<string> =>
      await serveStandIn(
        "builds-worker.ts",
        socket,
        { SANDBOX_DEADLINE_MS: String(DEADLINE_MS) },
        { PACKAGE_BUILDER: path.join(built, "package-builder.js") },
        { ESBUILD_WASM: path.join(built, "esbuild.wasm") }
      );
    coreUrl = await standIn(supervisor.socket);
    wide = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 4,
      log: () => {},
    });
    wideUrl = await standIn(wide.socket);
    otherUrl = await standIn(wide.socket);
  }, 300_000);

  afterAll(async () => {
    await Promise.all([supervisor.stop(), wide.stop()]);
    cleanUp();
  });

  const call = async (
    query: string,
    route = "/inspect",
    url = coreUrl
  ): Promise<z.infer<typeof outcomeSchema>> => {
    const response = await fetch(`${url}${route.slice(1)}?${query}`, {
      method: "POST",
    });
    return outcomeSchema.parse(await response.json());
  };

  /** How long core takes to answer a request that builds nothing. */
  const answerTime = async (): Promise<number> => {
    const started = Date.now();
    const response = await fetch(coreUrl, {
      signal: AbortSignal.timeout(2000),
    });
    await response.text();
    return Date.now() - started;
  };

  it("unpacks and reads a package on the sandbox host, not in core", async () => {
    const outcome = await call("package=plain");

    expect({
      status: outcome.status,
      inspected: inspectionsSchema
        .parse(outcome.value)
        .map(({ key, refusals }) => ({
          key,
          refusals,
        })),
    }).toStrictEqual({
      status: "ok",
      inspected: [{ key: "plain-package@1.0.0", refusals: [] }],
    });
  }, 60_000);

  it("reads a tarball larger than one message to the sandbox carries, whole and in order", async () => {
    const outcome = await call("package=large");

    expect({
      status: outcome.status,
      refusals: inspectionsSchema.parse(outcome.value)[0]?.refusals,
    }).toStrictEqual({ status: "ok", refusals: [] });
  }, 60_000);

  it("refuses a decompression bomb with a reason, unpacking only up to its limit", async () => {
    const outcome = await call("package=bomb");
    const [inspection] = inspectionsSchema.parse(outcome.value);

    expect(outcome.status).toBe("ok");
    expect(inspection?.refusals).toStrictEqual([
      expect.stringContaining("unpacks to more than"),
    ]);
  }, 60_000);

  it("refuses a second read of a tarball's start, so the builder reads each chunk once", async () => {
    const outcome = await call("builder=reread");

    expect(outcome.value).toStrictEqual([{ key: "refused" }]);
  }, 60_000);

  it("lets the builder read a tarball of several chunks only on, from where it left off", async () => {
    const outcome = await call("builder=rereadLater&package=large");

    expect(outcome.value).toStrictEqual([{ key: "read refused refused" }]);
  }, 60_000);

  it("reads the builder's code from core's assets once, however many calls it makes", async () => {
    const outcome = await call("package=plain", "/inspect-twice");

    expect({ status: outcome.status, read: outcome.value }).toStrictEqual({
      status: "ok",
      read: 1,
    });
  }, 60_000);

  it("reads the builder's code again once the request reading it was cancelled, rather than wait on that read for good", async () => {
    // workerd cancels a cancelled request's read, which then never ends:
    // the next request takes it for abandoned once a read may take no
    // longer (10 s), and reads the code itself.
    const outcome = await call("", "/cancelled-code");

    expect(outcome.status).toBe("ok");
    expect(outcome.value).toBe(2);
    expect(outcome.ms).toBeLessThan(15_000);
  }, 60_000);

  it("keeps running App code while builds hold the builders' share of the pool", async () => {
    // One build holds its owner's share, and another waits for it: an App's
    // call takes the pool's other process meanwhile, at once.
    const first = call("builder=busy");
    await sleep(500);
    const second = call("builder=busy");
    await sleep(200);
    const app = await call("", "/app");
    await Promise.all([first, second]);

    expect({ status: app.status, value: app.value }).toStrictEqual({
      status: "ok",
      value: 42,
    });
    expect(app.ms).toBeLessThan(2000);
  }, 60_000);

  it("builds an approved lock on the sandbox host and puts back every file it wrote, whole and in order, as the artifact describes it", async () => {
    const outcome = await call("package=built", "/build");

    expect(outcome).toMatchObject({ status: "ok" });

    const files = builtFilesSchema.parse(outcome.value);
    const exported = files.find(({ holdsExport }) => holdsExport);

    expect({
      // Each file as the artifact describes it: its length and SHA-256.
      returned: files.map(({ path: file, returned }) => ({
        file,
        ...returned,
      })),
      // The file holding the package's export took more than one chunk.
      exportedPastOneChunk: (exported?.returned.bytes ?? 0) > 1024 * 1024,
    }).toStrictEqual({
      returned: files.map(({ path: file, described }) => ({
        file,
        ...described,
      })),
      exportedPastOneChunk: true,
    });
  }, 60_000);

  it("takes no more of an artifact written back than it may be", async () => {
    const outcome = await call("builder=overwrite", "/build");

    expect(outcome.value).toStrictEqual({
      ok: false,
      refusals: [`written ${2 * 1024 * 1024}`],
    });
  }, 60_000);

  it("ends a builder a package keeps busy for good at its deadline, and core answers meanwhile", async () => {
    const running = call("builder=busy");
    // Asked while the builder spins on the sandbox host.
    await sleep(1000);
    const meanwhile = await answerTime();
    const outcome = await running;

    expect(meanwhile).toBeLessThan(ANSWER_MS);
    expect(outcome.status).toBe("bound");
    // At its deadline, not at the 60 s a builder's call may take otherwise.
    expect(outcome.ms).toBeLessThan(DEADLINE_MS + 5000);
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 5000, interval: 50 })
      .toBe(0);
  }, 60_000);

  it("ends a builder a package fills with memory, before its deadline", async () => {
    const before = supervisor.stats();
    const outcome = await call("builder=memory");
    const after = supervisor.stats();

    expect(outcome.status).toBe("bound");
    // Ended for its memory (or by V8 at its heap limit, as a crash).
    expect(
      after.memory - before.memory + (after.crashed - before.crashed)
    ).toBe(1);
  }, 60_000);

  it("holds builds to one owner's share of the pool: past it, a build waits for a place, then runs, never the package's fault", async () => {
    // Two processes, so the builders hold one: the second build, another
    // App's in another isolate of core, asks again until the first's place
    // comes free, then runs to its own deadline.
    const first = call("builder=busy&app=app-first");
    await sleep(500);
    const second = await call("builder=busy&app=app-second");

    expect({
      second: second.status,
      waitedForTheFirst: second.ms > DEADLINE_MS,
    }).toStrictEqual({ second: "bound", waitedForTheFirst: true });
    await expect(first).resolves.toMatchObject({ status: "bound" });
  }, 60_000);

  it("holds one App's builds to part of the builders' share, so another App's build still runs", async () => {
    // The builders' share of four processes is two. One App's build holds
    // one; its build from another isolate of core waits for that one.
    const held = call("builder=busy&app=app-a", "/inspect", wideUrl);
    await expect
      .poll(() => wide.stats().subOwnerPlaces, { timeout: 5000, interval: 50 })
      .toBe(1);
    const waiting = call("builder=busy&app=app-a", "/inspect", otherUrl);
    await expect
      .poll(() => wide.stats().waitingForOwners, {
        timeout: 5000,
        interval: 50,
      })
      .toBe(1);
    // The other place is another App's, while the first App's builds hold
    // theirs and wait.
    const other = await call("builder=busy&app=app-b", "/inspect", wideUrl);
    const [first, second] = await Promise.all([held, waiting]);

    expect({
      other: other.status,
      held: first.status,
      // It asked again until the App's place came free, then ran.
      waiting: second.status,
    }).toStrictEqual({ other: "bound", held: "bound", waiting: "bound" });
    // Every App's place given back once its process is gone.
    await expect
      .poll(() => wide.stats().subOwnerPlaces, { timeout: 5000, interval: 100 })
      .toBe(0);
  }, 60_000);
});
