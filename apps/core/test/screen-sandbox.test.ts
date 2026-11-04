import {
  appCompilerCode,
  isolateSettings,
  loadAppCompiler,
  packageBuilderCode,
  packageBuilderSettings,
  startAppCompiler,
  startPackageBuilder,
} from "@grasp-os/compiler";
import type { PlatformCode, Diagnostic } from "@grasp-os/compiler";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callStub } from "../src/sandboxed.ts";
import { buildScreens } from "../src/screens.ts";
import { probeModule } from "./isolate-probe.ts";

/** A screen with this code before its component. */
const screen = (code: string): Record<string, string> => ({
  "screens/desk.tsx": `${code}
export default function Desk() {
  return <p>desk</p>;
}
`,
});

/** Where a diagnostic is, what found it and what it says, on one line. */
const summary = ({ file, line, rule, message }: Diagnostic) =>
  `${file}:${line} ${rule}: ${message}`;

const summaries = async (files: Record<string, string>) => {
  const built = await buildScreens(env, files, "app-test");
  expect(built.ok).toBeFalsy();
  return built.diagnostics.map((diagnostic) => summary(diagnostic));
};

// What App code may try, to reach beyond the kit or to wear the compiler out.
describe("screen sandbox", { timeout: 60_000 }, () => {
  it("refuses a JSX runtime from outside the kit", async () => {
    await expect(
      summaries(screen("/** @jsxImportSource evil */"))
    ).resolves.toStrictEqual([
      expect.stringContaining(
        'screens/desk.tsx:undefined imports: "evil/jsx-runtime" is outside the kit'
      ),
    ]);
    await expect(
      summaries(screen("/** @jsxImportSource https://evil.example */"))
    ).resolves.toStrictEqual([
      expect.stringContaining(
        '"https://evil.example/jsx-runtime" is outside the kit'
      ),
    ]);
  });

  it("refuses names every object has as icons", async () => {
    await expect(
      summaries(
        screen(
          'import { toString, constructor } from "lucide-react";\nvoid [toString, constructor];'
        )
      )
    ).resolves.toStrictEqual([
      'screens/desk.tsx:1 imports: "toString", "constructor" is not a lucide-react icon.',
    ]);
  });

  it("says import() belongs at the top of the file", async () => {
    await expect(
      summaries({
        "screens/desk.tsx": `import { useEffect } from "react";

export default function Desk() {
  useEffect(() => {
    void import("../components/late");
  }, []);
  return <p>desk</p>;
}
`,
        "components/late.ts": "export const late = true;\n",
      })
    ).resolves.toStrictEqual([
      "screens/desk.tsx:5 compile: import() can't be used inside a component or hook: import the module at the top of the file.",
    ]);
  });

  it("builds a file of huge tokens quickly, keeping the classes in them", async () => {
    const built = await buildScreens(
      env,
      screen(
        `export const noise = "${")".repeat(150_000)}x";
export const classes = ["mt-7","${"(".repeat(400)}"];`
      ),
      "app-test"
    );

    expect(built.ok && built.css).toContain(".mt-7");
  });
});

/** How an isolate runs, apart from its code. */
type IsolateSettings = Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/** What the probe reports in an isolate with `settings`. */
const probed = async (settings: IsolateSettings): Promise<unknown> =>
  await callStub(
    env.LOADER.load({
      ...settings,
      mainModule: "probe.js",
      modules: { "probe.js": probeModule },
    }).getEntrypoint(),
    "report"
  );

/** `code` as a Loader takes it, with `bindings` in its env. */
const loaderCode = (
  code: PlatformCode,
  settings: IsolateSettings,
  bindings: Record<string, string>
): WorkerLoaderWorkerCode => {
  const modules: WorkerLoaderWorkerCode["modules"] = {};
  for (const [name, { type, bytes }] of Object.entries(code.modules)) {
    const text = new TextDecoder().decode(bytes);
    if (type === "json") {
      const json: unknown = JSON.parse(text);
      modules[name] = { json };
    } else if (type === "wasm") {
      modules[name] = { wasm: new Uint8Array(bytes).buffer };
    } else {
      modules[name] = text;
    }
  }
  return { ...settings, env: bindings, mainModule: code.mainModule, modules };
};

/**
 * Core's static assets, answering `probeModule` in place of the program at
 * `program` (`/compiler.js`, `/package-builder.js`): what a loader reads
 * as that program is then the probe, loaded as the program is.
 */
const probingAssets = (program: string): Fetcher => ({
  fetch: async (...args: Parameters<Fetcher["fetch"]>) =>
    new Request(...args).url.endsWith(program)
      ? new Response(probeModule, {
          headers: { "content-type": "text/javascript" },
        })
      : await env.ASSETS.fetch(...args),
  connect: env.ASSETS.connect.bind(env.ASSETS),
});

/** A tarball's header, as core hands the builder one to read. */
const header = {
  key: "left-pad@1.3.0",
  name: "left-pad",
  version: "1.3.0",
  integrity: "sha512-x",
  size: 1,
};

/** What `entrypoint` answers to `method` with `args`: "worked", or why it refused. */
const refusalOf = async (
  entrypoint: unknown,
  method: string,
  args: readonly unknown[]
): Promise<string> =>
  await callStub(entrypoint, method, args).then(
    () => "worked",
    (error: unknown) =>
      error instanceof Error && error.message.includes("refuses to work there")
        ? "refused"
        : String(error)
  );

/** Whether `compiler` checks an empty draft's screens: it ran. */
const checked = async (compiler: unknown): Promise<string> => {
  const answer = await callStub(compiler, "check", ["screens", {}]);
  return Array.isArray(answer) ? "checked" : JSON.stringify(answer);
};

describe(
  "the platform's isolates that read App code and packages",
  { timeout: 60_000 },
  () => {
    it.each([
      [
        "the App compiler's code, as a build loads it,",
        async () =>
          await loadAppCompiler(env.LOADER, probingAssets("/compiler.js")),
      ],
      [
        "the package builder's code, as a resolve or a build loads it,",
        async () =>
          await startPackageBuilder(
            env.LOADER,
            probingAssets("/package-builder.js")
          ),
      ],
    ])("give %s no bindings and no network", async (_case, load) => {
      await expect(callStub(await load(), "report")).resolves.toStrictEqual({
        env: [],
        imported: [],
        fetch: "refused",
        connect: "refused",
      });
    });

    it("read the compiler's code only to start its isolate, and keep none of it: once for builds that start together, never for a build on the warm one", async () => {
      // Core keeps none of it (compiler.js is 22 MB as a string, kit.json
      // 11 MB, esbuild.wasm 14 MB, in a 128 MB isolate): only the Loader
      // needs it, to start the compiler's isolate. Core's static assets,
      // noting each file read: a fresh binding, so no read before this
      // test is shared with it.
      const read: string[] = [];
      const assets: Fetcher = {
        fetch: async (...args: Parameters<Fetcher["fetch"]>) => {
          const path = new URL(new Request(...args).url).pathname;
          read.push(path.slice(path.lastIndexOf("/") + 1));
          return await env.ASSETS.fetch(...args);
        },
        connect: env.ASSETS.connect.bind(env.ASSETS),
      };
      // Three builds start fresh isolates together: one read of each file.
      const fresh = await Promise.all(
        Array.from(
          { length: 3 },
          async () => await loadAppCompiler(env.LOADER, assets)
        )
      );
      // Each answers a check: its isolate started from the code read.
      const checks = await Promise.all(
        fresh.map(async (compiler) => await checked(compiler))
      );
      const together = read.toSorted();
      // The warm one: started once, then found loaded by its name, so the
      // second build reads nothing.
      await checked(startAppCompiler(env.LOADER, assets));
      const started = read.length;
      const warm = await checked(startAppCompiler(env.LOADER, assets));
      const warmRead = read.slice(started);
      // Nothing was kept: a fresh isolate after them reads it all again.
      const before = read.length;
      const anew = await checked(await loadAppCompiler(env.LOADER, assets));
      expect({
        together,
        checks,
        warm,
        warmRead,
        anew,
        anewRead: read.slice(before).toSorted(),
      }).toStrictEqual({
        together: ["compiler.js", "esbuild.wasm", "kit.json"],
        checks: ["checked", "checked", "checked"],
        warm: "checked",
        warmRead: [],
        anew: "checked",
        anewRead: ["compiler.js", "esbuild.wasm", "kit.json"],
      });
    });

    it("hold both isolates to no outbound at all, the one barrier to the network shown to hold", () => {
      // `subRequests: 0` doesn't stop a fetch on workerd (the control below
      // reaches its outbound with it), and the tests' default outbound
      // reaches no host either way, so only this says a refactor kept the
      // compiler and the builder off the network.
      expect([
        isolateSettings.globalOutbound,
        packageBuilderSettings.globalOutbound,
      ]).toStrictEqual([null, null]);
    });

    it("would report what an isolate with a binding and an outbound can reach, its limits as the compiler's", async () => {
      // The probe's control: given what the settings withhold, it sees it,
      // so their refusals are theirs, not the probe's. The compiler's own
      // limits, `subRequests: 0` among them, don't stop the fetch.
      await expect(
        probed({
          ...isolateSettings,
          env: { SECRET: "not for the compiler" },
          globalOutbound: env.ASSETS,
        })
      ).resolves.toMatchObject({ env: ["SECRET"], fetch: "reached" });
    });

    it.each([
      [
        "the App compiler's build",
        appCompilerCode,
        isolateSettings,
        "build",
        ["screens", {}],
      ],
      [
        "the App compiler's inspection",
        appCompilerCode,
        isolateSettings,
        "inspect",
        ["app", {}],
      ],
      [
        "the package builder's inspection",
        packageBuilderCode,
        packageBuilderSettings,
        "inspect",
        [{ limits: {}, packages: [] }],
      ],
      [
        "the package builder's build",
        packageBuilderCode,
        packageBuilderSettings,
        "build",
        [{}],
      ],
    ] as const)(
      "refuse %s in an isolate handed a binding",
      async (_case, code, settings, method, args) => {
        const bound = env.LOADER.load(
          loaderCode(await code(env.ASSETS), settings, { DB: "a credential" })
        ).getEntrypoint();
        await expect(refusalOf(bound, method, args)).resolves.toBe("refused");
      }
    );

    it.each([
      [
        "an inspection's",
        "inspectRead",
        (read: () => Promise<Uint8Array>) => [{}, [header], read],
      ],
      [
        "a build's",
        "buildRead",
        (read: () => Promise<Uint8Array>) => [
          { packages: [header] },
          read,
          async () => {
            // Nothing is written.
          },
        ],
      ],
    ] as const)(
      "refuse %s tarballs in an isolate handed a binding before reading a byte of them",
      async (_case, method, argsWith) => {
        let reads = 0;
        const read = async (): Promise<Uint8Array> => {
          reads += 1;
          return await Promise.resolve(new Uint8Array(0));
        };
        const bound = env.LOADER.load(
          loaderCode(
            await packageBuilderCode(env.ASSETS),
            packageBuilderSettings,
            { DB: "a credential" }
          )
        ).getEntrypoint();
        await expect(refusalOf(bound, method, argsWith(read))).resolves.toBe(
          "refused"
        );
        expect(reads).toBe(0);
      }
    );

    it("refuses to compile behind an entrypoint handed props", async () => {
      const code = loaderCode(
        await appCompilerCode(env.ASSETS),
        isolateSettings,
        {}
      );
      const withProps = env.LOADER.load(code).getEntrypoint(undefined, {
        props: { owner: "someone" },
      });
      await expect(
        refusalOf(withProps, "build", ["screens", {}])
      ).resolves.toBe("refused");
    });
  }
);
