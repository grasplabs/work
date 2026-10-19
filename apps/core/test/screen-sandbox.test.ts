import {
  appCompilerCode,
  isolateSettings,
  loadAppCompiler,
  packageBuilderCode,
  packageBuilderSettings,
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

  it("refuses more files and characters than a build takes", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [
        `components/c${index}.ts`,
        "export {};\n",
      ])
    );
    await expect(summaries({ ...screen(""), ...many })).resolves.toStrictEqual([
      "undefined:undefined limits: The App has 202 files; a build takes at most 200.",
    ]);
    // Files a build doesn't read don't count.
    const unread = Object.fromEntries(
      Object.keys(many).map((path) => [`workflows/${path}`, "x".repeat(10_000)])
    );
    await expect(
      buildScreens(env, { ...screen(""), ...unread }, "app-test")
    ).resolves.toMatchObject({ ok: true });

    const long = `// ${"x".repeat(200_001)}\n`;
    await expect(
      summaries({
        ...screen(""),
        "components/a.ts": long,
        "components/b.ts": "x".repeat(199_000),
        "components/c.ts": "x".repeat(199_000),
        "components/d.ts": "x".repeat(199_000),
        "components/e.ts": "x".repeat(199_000),
        "components/f.ts": "x".repeat(199_000),
      })
    ).resolves.toStrictEqual([
      expect.stringContaining(
        "components/a.ts:undefined limits: This file has 200005 characters; a file can have at most 200000."
      ),
      expect.stringContaining(
        "undefined:undefined limits: The App's files have 1195"
      ),
    ]);
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
