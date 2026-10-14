import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { buildScreens, buildServer } from "../../src/screens.ts";

// The screen compiler on-prem: it runs on the sandbox host this project
// starts (src/platform-sandbox.ts), never in core's own process, whose
// Loader here throws if a build reaches for it. A type built to recurse
// holds TypeScript's checker for good: the supervisor ends it at its
// deadline, and core answers meanwhile.

/** A Loader core never reaches on-prem: compiling here would hold core. */
const noLoader: WorkerLoader = {
  get: () => {
    throw new Error("Core loaded the compiler itself.");
  },
  load: () => {
    throw new Error("Core loaded the compiler itself.");
  },
};

/** How long a build may take on the sandbox host here. */
const DEADLINE_MS = 4000;

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

/** Core's env as on-prem, its Loader one a build must never reach. */
const onPrem = { ...env, LOADER: noLoader };

/** A screen with this code before its component. */
const screen = (code: string): Record<string, string> => ({
  "screens/desk.tsx": `${code}
export default function Desk() {
  return <p>desk</p>;
}
`,
});

/**
 * Types each of which takes TypeScript's checker seconds to expand, a
 * union of 2^16 nested tuples, and none of which reuses another's work:
 * a few lines that hold the checker far past any deadline.
 */
const recursiveTypes = `type Split<T, N extends unknown[]> = N extends [unknown, ...infer R] ? Split<[T, 0], R> | Split<[T, 1], R> : T;
type Sixteen = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
${Array.from(
  { length: 40 },
  (_, index) =>
    `export const held${index}: Split<"${index}", Sixteen> = ${index};`
).join("\n")}`;

/** How long core takes to answer a request that builds nothing. */
const answerTime = async (): Promise<number> => {
  const started = Date.now();
  const response = await exports.default.fetch("https://core/health");
  await response.text();
  return Date.now() - started;
};

describe("the screen compiler on-prem", () => {
  it("builds an App's screens on the sandbox host, not in core", async () => {
    const built = await buildScreens(onPrem, screen(""));

    expect({
      ok: built.ok,
      screen: built.ok && Object.keys(built.screens),
    }).toStrictEqual({ ok: true, screen: [expect.stringContaining("desk")] });
  });

  it("builds an App's server code on the sandbox host", async () => {
    const built = await buildServer(onPrem, {
      "app/server.ts": `import { DurableObject } from "cloudflare:workers";\n\nexport class App extends DurableObject {\n  book(): string {\n    return "booked";\n  }\n}\n`,
    });

    expect(built.ok).toBeTruthy();
  });

  it("says what fails to type-check, as it does on Cloudflare", async () => {
    const built = await buildScreens(
      onPrem,
      screen('export const count: number = "seven";')
    );

    expect(built.ok ? [] : built.diagnostics.map(({ rule }) => rule)).toContain(
      "TS2322"
    );
  });

  it("stops a screen whose types recurse without end at its deadline, and core answers meanwhile", async () => {
    const started = Date.now();
    const building = buildScreens(
      { ...onPrem, SANDBOX_DEADLINE_MS: String(DEADLINE_MS) },
      screen(recursiveTypes)
    );
    // Asked while the checker spins on the sandbox host.
    await scheduler.wait(DEADLINE_MS / 2);
    const meanwhile = await answerTime();
    const built = await building;
    const took = Date.now() - started;

    expect(meanwhile).toBeLessThan(ANSWER_MS);
    expect(
      built.ok ? [] : built.diagnostics.map(({ message }) => message)
    ).toStrictEqual([
      expect.stringContaining("The compiler was stopped before it finished"),
    ]);
    // At its deadline, not at the 30 s a build may take otherwise.
    expect(took).toBeLessThan(DEADLINE_MS + 5000);
  });

  it("runs the compiler once for a screen it was stopped on for its own sake, however often it's viewed", async () => {
    // Every build kept: one per time the compiler ran to an end it keeps.
    let kept = 0;
    const counting = {
      ...onPrem,
      FILES: {
        get: env.FILES.get.bind(env.FILES),
        put: async (...args: Parameters<R2Bucket["put"]>) => {
          kept += 1;
          return await env.FILES.put(...args);
        },
      },
    };
    const files = screen(`${recursiveTypes}\n// viewed`);
    // Three views at once, then one more once they're done.
    const views = await Promise.all(
      [1, 2, 3].map(async () => await buildScreens(counting, files))
    );
    const started = Date.now();
    const later = await buildScreens(counting, files);
    const tookLater = Date.now() - started;

    expect(
      [...views, later].map((built) =>
        built.ok ? "built" : built.diagnostics[0]?.message.slice(0, 44)
      )
    ).toStrictEqual(
      Array.from(
        { length: 4 },
        () => "The compiler was stopped before it finished:"
      )
    );
    expect(kept).toBe(1);
    // Read from the cache: the compiler didn't run again.
    expect(tookLater).toBeLessThan(1000);
  }, 120_000);

  it("reads the compiler's code from core's assets once, however many builds it runs", async () => {
    let read = 0;
    const counting = {
      ...onPrem,
      ASSETS: {
        fetch: async (...args: Parameters<Fetcher["fetch"]>) => {
          if (new Request(...args).url.endsWith("/compiler.js")) {
            read += 1;
          }
          return await env.ASSETS.fetch(...args);
        },
        connect: env.ASSETS.connect.bind(env.ASSETS),
      },
    };
    const first = await buildScreens(counting, screen("// first read"));
    const second = await buildScreens(counting, screen("// second read"));

    expect({ first: first.ok, second: second.ok, read }).toStrictEqual({
      first: true,
      second: true,
      read: 1,
    });
  });

  it("builds the same screen again once the sandbox stopped it at its deadline, as that stop isn't cached", async () => {
    const files = screen(`${recursiveTypes}\n// again`);
    const stopped = { ...onPrem, SANDBOX_DEADLINE_MS: "1500" };
    const first = await buildScreens(stopped, files);
    const started = Date.now();
    const second = await buildScreens(stopped, files);

    expect({ first: first.ok, second: second.ok }).toStrictEqual({
      first: false,
      second: false,
    });
    // Built again, to its deadline: not a failure read from the cache.
    expect(Date.now() - started).toBeGreaterThan(1000);
  });
});
