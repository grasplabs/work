import {
  appCompilerCode,
  isolateSettings,
  packageBuilderCode,
  packageBuilderSettings,
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

describe(
  "the platform's isolates that read App code and packages",
  { timeout: 60_000 },
  () => {
    it.each([
      ["the App compiler's", isolateSettings],
      ["the package builder's", packageBuilderSettings],
    ])("give %s code no bindings and no network", async (_case, settings) => {
      await expect(probed(settings)).resolves.toStrictEqual({
        env: [],
        imported: [],
        fetch: "refused",
        connect: "refused",
      });
    });

    it("would report what an isolate with a binding and an outbound can reach", async () => {
      // The probe's control: given what the settings above withhold, it
      // sees it, so their refusals are theirs, not the probe's.
      await expect(
        probed({
          ...isolateSettings,
          env: { SECRET: "not for the compiler" },
          globalOutbound: env.ASSETS,
          limits: { cpuMs: 20_000 },
        })
      ).resolves.toMatchObject({ env: ["SECRET"], fetch: "reached" });
    });

    it.each([
      [
        "the App compiler",
        appCompilerCode,
        isolateSettings,
        ["build", ["screens", {}]],
      ],
      [
        "the package builder",
        packageBuilderCode,
        packageBuilderSettings,
        ["inspect", [{ limits: {}, packages: [] }]],
      ],
    ] as const)(
      "has %s refuse to work in an isolate handed a binding",
      async (_case, code, settings, [method, args]) => {
        const bound = env.LOADER.load(
          loaderCode(await code(env.ASSETS), settings, { DB: "a credential" })
        ).getEntrypoint();
        await expect(
          callStub(bound, method, args).then(
            () => "worked",
            (error: unknown) =>
              error instanceof Error && error.message.includes("handed DB")
                ? "refused"
                : String(error)
          )
        ).resolves.toBe("refused");
      }
    );
  }
);
