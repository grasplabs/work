import { kitModules } from "@grasp-os/compiler";
import { compatibilityDate } from "@grasp-os/shared/runtime";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildKeepMs, buildScreens, sweepBuilds } from "../src/screens.ts";

/** A sample App: two screens on the kit, sharing one of its own components. */
const sampleApp: Record<string, string> = {
  "screens/desk.tsx": `import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@grasp-os/ui/components/card";
import { useState } from "react";

import { Greeting } from "../components/greeting";

export default function Desk() {
  const [count, setCount] = useState(0);
  return (
    <Card>
      <CardHeader>
        <CardTitle><Greeting name="desk" /></CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-2">
          <Button onClick={() => setCount(count + 1)}>Clicked {count}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
`,
  "screens/inbox.tsx": `import { Badge } from "@grasp-os/ui/components/badge";
import { Input } from "@grasp-os/ui/components/input";
import { type LucideProps, InboxIcon } from "lucide-react";

import { Greeting } from "../components/greeting";
import { Mail } from "../components/icons";

const iconProps: LucideProps = { "aria-hidden": true };

export default function Inbox() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Greeting name="inbox" />
      <Badge variant="secondary"><InboxIcon {...iconProps} /> 3 new</Badge>
      <Mail {...iconProps} />
      <Input placeholder="Search" />
    </main>
  );
}
`,
  "components/icons.ts": `export { MailIcon as Mail } from "lucide-react";
`,
  "components/greeting.tsx": `export function Greeting({ name }: { name: string }) {
  return <h1 className="text-lg font-semibold">Hello from {name}</h1>;
}
`,
};

/** These of the kit's modules, by flat name. */
const kitModulesNamed = async (
  names: string[]
): Promise<Record<string, string>> => {
  const { modules } = await kitModules(env.ASSETS);
  return Object.fromEntries(names.map((name) => [name, modules[name] ?? ""]));
};

/**
 * Loads modules into a fresh isolate, as a page does with an import map,
 * and says what `imports` evaluate to there.
 */
const evaluate = async (
  code: Record<string, string>,
  imports: string[]
): Promise<unknown> => {
  const modules = Object.fromEntries(
    Object.entries(code).map(([name, js]) => [name, { js }])
  );
  const probe = `${imports.map((name, index) => `import * as m${index} from "${name}";`).join("\n")}
export default {
  fetch: () => Response.json({
${imports.map((name, index) => `    "${name}": Object.fromEntries(Object.entries(m${index}).map(([key, value]) => [key, typeof value])),`).join("\n")}
  }),
};`;
  const worker = env.LOADER.load({
    compatibilityDate,
    mainModule: "probe.js",
    modules: { ...modules, "probe.js": probe },
    globalOutbound: null,
  });
  const response = await worker.getEntrypoint().fetch("https://probe/");
  return await response.json();
};

/** The kit's modules a build's screens load, all of them. */
const kitModulesOf = (built: {
  screens: Record<string, { kitModules: string[] }>;
}): string[] => [
  ...new Set(
    Object.values(built.screens).flatMap(({ kitModules: names }) => names)
  ),
];

/** A screen that says `text`. */
const screen = (text: string): Record<string, string> => ({
  "screens/desk.tsx": `export default function Desk() {
  return <p>${text}</p>;
}
`,
});

/** A Worker Loader that fails the test if anything is built. */
const noBuilds: WorkerLoader = {
  get: () => {
    throw new Error("Built again");
  },
  load: () => {
    throw new Error("Built again");
  },
};

/** Runs the cron's builds sweep at `at` until it has read every kind. */
const sweptAt = async (at: number): Promise<void> => {
  for (let run = 0; run < 24; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another, as the cron runs
    await sweepBuilds(env, new Date(at));
  }
};

// Every build starts an isolate with the compiler in it.
describe("screen builds", { timeout: 60_000 }, () => {
  it("builds every screen into modules that run on the kit's", async () => {
    const built = await buildScreens(env, sampleApp, "app-test");
    if (!built.ok) {
      throw new Error(JSON.stringify(built.diagnostics, null, 2));
    }
    expect(built.diagnostics).toStrictEqual([]);

    // Evaluating them with only the kit modules the build names links
    // every import, the icons' too, without `require`.
    await expect(
      evaluate(
        {
          ...(await kitModulesNamed(kitModulesOf(built))),
          ...built.modules,
        },
        ["app~screens~desk.js", "app~screens~inbox.js"]
      )
    ).resolves.toMatchObject({
      "app~screens~desk.js": { default: "function" },
      "app~screens~inbox.js": { default: "function" },
    });
    // The App's own classes, the kit's classes (quotes and all, from the
    // button's icon sizing) and the kit's theme.
    expect(built.css).toContain(".grid-cols-3");
    expect(built.css).toContain("svg:not([class*='size-'])");
    expect(built.css).toContain("--primary:");
  });

  it("names only the kit modules the App needs", async () => {
    const built = await buildScreens(env, sampleApp, "app-test");

    expect(built.ok && kitModulesOf(built)).toContain(
      "lucide-react~icons~inbox.js"
    );
    expect(built.ok && kitModulesOf(built)).not.toContain(
      "lucide-react~icons~house.js"
    );
  });

  it("says what each screen loads: what it imports, not the App's other screens", async () => {
    const built = await buildScreens(env, sampleApp, "app-test");
    if (!built.ok) {
      throw new Error(JSON.stringify(built.diagnostics, null, 2));
    }
    const desk = built.screens["app~screens~desk.js"];
    const inbox = built.screens["app~screens~inbox.js"];

    expect(desk?.modules).toStrictEqual([
      "app~components~greeting.js",
      "app~screens~desk.js",
    ]);
    expect(inbox?.modules).toStrictEqual([
      "app~components~greeting.js",
      "app~components~icons.js",
      "app~screens~inbox.js",
    ]);
    const button = "@grasp-os~ui~components~button.js";
    const badge = "@grasp-os~ui~components~badge.js";
    const icon = "lucide-react~icons~inbox.js";
    const has = (modules: string[] | undefined): boolean[] =>
      [button, badge, icon].map((name) => modules?.includes(name) ?? false);
    expect({
      desk: has(desk?.kitModules),
      inbox: has(inbox?.kitModules),
    }).toStrictEqual({
      desk: [true, false, false],
      inbox: [false, true, true],
    });

    // Each screen runs on what the build names for it and nothing else.
    const entries = Object.entries(built.screens);
    await expect(
      Promise.all(
        entries.map(
          async ([entry, closure]) =>
            await evaluate(
              {
                ...(await kitModulesNamed(closure.kitModules)),
                ...Object.fromEntries(
                  closure.modules.map((name) => [
                    name,
                    built.modules[name] ?? "",
                  ])
                ),
              },
              [entry]
            )
        )
      )
    ).resolves.toMatchObject(
      entries.map(([entry]) => ({ [entry]: { default: "function" } }))
    );
  });

  it("keeps every component of the kit available, and loads none a screen doesn't import", async () => {
    const { modules } = await kitModules(env.ASSETS);
    const components = Object.keys(modules).filter((name) =>
      name.startsWith("@grasp-os~ui~components~")
    );
    const specifiers = components.map((name) =>
      name.slice(0, -".js".length).replaceAll("~", "/")
    );
    const built = await buildScreens(
      env,
      {
        ...screen("small"),
        "screens/all.tsx": `${specifiers.map((specifier, index) => `import * as c${index} from "${specifier}";`).join("\n")}

export default function All() {
  return <p>{[${specifiers.map((_, index) => `c${index}`).join(", ")}].length}</p>;
}
`,
      },
      "app-test"
    );
    if (!built.ok) {
      throw new Error(JSON.stringify(built.diagnostics, null, 2));
    }
    const all = built.screens["app~screens~all.js"];
    const small = built.screens["app~screens~desk.js"];

    expect(components.length).toBeGreaterThan(0);
    expect(all?.kitModules).toStrictEqual(expect.arrayContaining(components));
    await expect(
      evaluate(
        {
          ...(await kitModulesNamed(all?.kitModules ?? [])),
          "app~screens~all.js": built.modules["app~screens~all.js"] ?? "",
        },
        ["app~screens~all.js"]
      )
    ).resolves.toMatchObject({ "app~screens~all.js": { default: "function" } });
    // The screen next to it, which imports none of them, loads none of them.
    expect(
      small?.kitModules.filter((name) => name.startsWith("@grasp-os~ui~"))
    ).toStrictEqual([]);
  });

  it("has the classes of the kit modules an App loads in its CSS, not the catalog's", async () => {
    // The sidebar's width, a class only the sidebar has.
    const sidebarClass = "w-\\(--sidebar-width\\)";
    const without = await buildScreens(env, sampleApp, "app-test");
    const withSidebar = await buildScreens(
      env,
      {
        "screens/desk.tsx": `import { Sidebar, SidebarProvider } from "@grasp-os/ui/components/sidebar";

export default function Desk() {
  return (
    <SidebarProvider>
      <Sidebar />
    </SidebarProvider>
  );
}
`,
      },
      "app-test"
    );

    expect(without.ok && without.css).not.toContain(sidebarClass);
    expect(withSidebar.ok && withSidebar.css).toContain(sidebarClass);
  });

  it("has React DOM in the kit, for the page that renders screens", async () => {
    const { modules } = await kitModules(env.ASSETS);

    await expect(
      evaluate(modules, ["react-dom~client.js"])
    ).resolves.toMatchObject({
      "react-dom~client.js": { createRoot: "function" },
    });
  });

  it("runs screens through the React Compiler", async () => {
    const built = await buildScreens(
      env,
      {
        "screens/counter.tsx": `import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`,
      },
      "app-test"
    );

    expect(built.ok && built.modules["app~screens~counter.js"]).toContain(
      '"react~compiler-runtime.js"'
    );
  });

  it("refuses imports from outside the kit, saying where", async () => {
    const built = await buildScreens(
      env,
      {
        "screens/desk.tsx": `import leftPad from "left-pad";
import { Dialog } from "@base-ui/react/dialog";
import { Nope } from "@grasp-os/ui/components/nope";
import { secret } from "../../outside";
import { InboxIcon, NotAnIcon } from "lucide-react";
import * as icons from "lucide-react";
export * from "lucide-react";

const remote = import("https://example.com/remote.js");

export default function Desk() {
  return <p>{leftPad(Dialog, Nope, secret, remote, InboxIcon, NotAnIcon, icons)}</p>;
}
`,
      },
      "app-test"
    );

    expect(built.ok).toBeFalsy();
    expect(
      built.diagnostics.map(
        ({ file, line, rule, message }) => `${file}:${line} ${rule}: ${message}`
      )
    ).toStrictEqual([
      expect.stringContaining(
        'screens/desk.tsx:1 imports: "left-pad" is outside the kit'
      ),
      expect.stringContaining(
        'screens/desk.tsx:2 imports: "@base-ui/react/dialog" is outside the kit'
      ),
      expect.stringContaining(
        'screens/desk.tsx:3 imports: "@grasp-os/ui/components/nope" is outside the kit'
      ),
      'screens/desk.tsx:4 imports: "../../outside" is not a file in this App.',
      'screens/desk.tsx:5 imports: "NotAnIcon" is not a lucide-react icon.',
      expect.stringContaining(
        "screens/desk.tsx:6 imports: import or export icons from lucide-react by name"
      ),
      expect.stringContaining(
        "screens/desk.tsx:7 imports: import or export icons from lucide-react by name"
      ),
      expect.stringContaining(
        'screens/desk.tsx:9 imports: "https://example.com/remote.js" is outside the kit'
      ),
    ]);
  });

  it("takes a component's declaration file as types alone, never as a module", async () => {
    const built = await buildScreens(
      env,
      {
        "screens/labels.tsx": `import type { Label } from "../components/labels";
import { Tag } from "../components/tag";

const label: Label = "urgent";

export default function Labels() {
  return <Tag label={label} />;
}
`,
        "components/labels.d.ts": `export type Label = "urgent" | "later";
export declare const labels: readonly Label[];
`,
        // A module beside its declaration: a value import names the module.
        "components/tag.tsx": `export function Tag({ label }: { label: string }) {
  return <span>{label}</span>;
}
`,
        "components/tag.d.ts": `export declare function Tag(props: { label: string }): unknown;
`,
      },
      "app-test"
    );

    expect(
      built.ok ? Object.keys(built.modules).toSorted() : built
    ).toStrictEqual(["app~components~tag.js", "app~screens~labels.js"]);
  });

  it("refuses a value import of a declaration file, which holds only types", async () => {
    const built = await buildScreens(
      env,
      {
        "screens/labels.tsx": `import { labels } from "../components/labels";
import { more } from "../components/labels.d.ts";
import { Ticket } from "../server";
import { value } from "../components/value";

export default function Labels() {
  return <p>{[labels, more, Ticket, value].join()}</p>;
}
`,
        // A folder module beside a declaration of the same name: TypeScript
        // reads the declaration first, so the screen would run other code
        // than it was checked against.
        "components/value.d.ts": `export declare const value: string;
`,
        "components/value/index.ts": `export const value = 123;
`,
        "components/labels.d.ts": `export declare const labels: readonly string[];
export declare const more: readonly string[];
`,
        "server.d.ts": `export declare const Ticket: string;
`,
      },
      "app-test"
    );

    expect(
      built.ok
        ? built
        : built.diagnostics.map(
            ({ file, line, rule, message }) =>
              `${file}:${line} ${rule}: ${message}`
          )
    ).toStrictEqual([
      'screens/labels.tsx:1 imports: "../components/labels" is components/labels.d.ts, a declaration file: it holds only types, so import it with import type.',
      'screens/labels.tsx:2 imports: "../components/labels.d.ts" is components/labels.d.ts, a declaration file: it holds only types, so import it with import type.',
      'screens/labels.tsx:3 imports: "../server" is server.d.ts, a declaration file: it holds only types, so import it with import type.',
      'screens/labels.tsx:4 imports: "../components/value" is components/value.d.ts, a declaration file: it holds only types, so import it with import type.',
    ]);
  });

  it("builds the same files once and serves them from the cache after", async () => {
    // Files of this test's own, so no earlier build is in the cache.
    const files = screen(`once ${crypto.randomUUID()}`);
    let started = 0;
    const counting: WorkerLoader = {
      get: (name, code) => {
        started += 1;
        return env.LOADER.get(name, code);
      },
      load: (code) => env.LOADER.load(code),
    };
    const built = await buildScreens(
      { ...env, LOADER: counting },
      files,
      "app-test"
    );
    expect({ ok: built.ok, started }).toStrictEqual({ ok: true, started: 1 });

    // A build is its files': whichever App or version they come from, the
    // same files, next to any the build doesn't read, are built already.
    const cached = await buildScreens(
      { ...env, LOADER: noBuilds },
      files,
      "app-test"
    );
    expect(cached).toStrictEqual(built);
    await expect(
      buildScreens(
        { ...env, LOADER: noBuilds },
        { ...files, "operations/notes.ts": "export {};\n" },
        "app-test"
      )
    ).resolves.toStrictEqual(built);

    // Other files it reads build again.
    await expect(
      buildScreens(
        { ...env, LOADER: noBuilds },
        { ...files, "components/extra.ts": "export {};\n" },
        "app-test"
      )
    ).rejects.toThrow("Built again");
  });

  it("keeps a cached build while it is used, and builds one the sweep took again, the same", async () => {
    const files = screen(`kept ${crypto.randomUUID()}`);
    const built = await buildScreens(env, files, "app-test");
    const fromCache = async (at: number, failWrites = false) => {
      // R2, as core writes to it, counting what is written, or failing it.
      let writes = 0;
      const counted = {
        ...env,
        LOADER: noBuilds,
        FILES: {
          get: env.FILES.get.bind(env.FILES),
          put: async (...args: Parameters<R2Bucket["put"]>) => {
            writes += 1;
            if (failWrites) {
              throw new Error("R2 is out");
            }
            return await env.FILES.put(...args);
          },
        },
      };
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at);
      try {
        const served = await buildScreens(counted, files, "app-test");
        return { served, writes };
      } finally {
        vi.useRealTimers();
      }
    };
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Served a day on, it stays as it is; past half its time, it is
    // written again as used then, so a build in use never reaches the
    // sweep's limit.
    const refreshed = now + buildKeepMs / 2 + day;
    const soon = await fromCache(now + day);
    // A refresh that fails still serves the build.
    const unwritten = await fromCache(refreshed, true);
    const later = await fromCache(refreshed);
    // An object of another kind of cache, which this sweep leaves alone.
    await env.FILES.put("package-builds/kept.json", "{}");
    // Past its first use's time, but not its last's: kept.
    await sweptAt(now + buildKeepMs + day);
    const kept = await buildScreens(
      { ...env, LOADER: noBuilds },
      files,
      "app-test"
    );
    // Past its last use's time: gone.
    await sweptAt(refreshed + buildKeepMs + day);
    const swept = await buildScreens(
      { ...env, LOADER: noBuilds },
      files,
      "app-test"
    ).then(
      () => "served",
      (error: unknown) => (error instanceof Error ? error.message : "")
    );
    const rebuilt = await buildScreens(env, files, "app-test");
    expect({
      soon,
      unwritten,
      later,
      kept,
      swept,
      rebuilt,
      other: (await env.FILES.head("package-builds/kept.json")) !== null,
    }).toStrictEqual({
      soon: { served: built, writes: 0 },
      unwritten: { served: built, writes: 1 },
      later: { served: built, writes: 1 },
      kept: built,
      swept: "Built again",
      rebuilt: built,
      other: true,
    });
  });

  it("serves no build, not even a cached one, where nothing bounds the compiler", async () => {
    const files = screen(`unbounded ${crypto.randomUUID()}`);
    const built = await buildScreens(env, files, "app-test");
    expect(built.ok).toBeTruthy();

    // On plain workerd with no sandbox and no opt-in (src/screens.ts).
    await expect(
      buildScreens({ ...env, SANDBOX_IN_PROCESS: undefined }, files, "app-test")
    ).rejects.toThrow("No sandbox bounds App code here");
  });

  it("builds other files on their own", async () => {
    const first = await buildScreens(env, screen("first"), "app-test");
    const second = await buildScreens(env, screen("second"), "app-test");

    expect(first.ok && first.modules["app~screens~desk.js"]).toContain("first");
    expect(second.ok && second.modules["app~screens~desk.js"]).toContain(
      "second"
    );
  });
});
