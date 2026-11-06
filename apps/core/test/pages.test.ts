import { kitModules } from "@grasp-os/compiler";
import { compatibilityDate } from "@grasp-os/shared/runtime";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildKeepMs, buildPages, sweepBuilds } from "../src/pages.ts";

/** A sample App: two pages on the kit, sharing one of its own components. */
const sampleApp: Record<string, string> = {
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@grasp-os/ui/components/card";
import { useState } from "react";

import { Greeting } from "../components/greeting";

function Desk() {
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
export const Route = createFileRoute("/")({ component: Desk });
`,
  "src/routes/inbox.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { Badge } from "@grasp-os/ui/components/badge";
import { Input } from "@grasp-os/ui/components/input";
import { type LucideProps, InboxIcon } from "lucide-react";

import { Greeting } from "../components/greeting";
import { Mail } from "../components/icons";

const iconProps: LucideProps = { "aria-hidden": true };

function Inbox() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Greeting name="inbox" />
      <Badge variant="secondary"><InboxIcon {...iconProps} /> 3 new</Badge>
      <Mail {...iconProps} />
      <Input placeholder="Search" />
    </main>
  );
}
export const Route = createFileRoute("/inbox")({ component: Inbox });
`,
  "src/components/icons.ts": `export { MailIcon as Mail } from "lucide-react";
`,
  "src/components/greeting.tsx": `export function Greeting({ name }: { name: string }) {
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

/**
 * `names` of a build's App modules, each at its address, as a frame loads
 * them: they import each other there (@grasp-os/compiler's
 * module-addresses.ts), the kit's by flat name.
 */
const atAddresses = (
  built: { modules: Record<string, string>; addresses: Record<string, string> },
  names: string[] = Object.keys(built.modules)
): Record<string, string> =>
  Object.fromEntries(
    names.map((name) => [
      `${built.addresses[name] ?? ""}.js`,
      built.modules[name] ?? "",
    ])
  );

/** Where a build loads its App module `name`: at its address. */
const addressOf = (
  built: { addresses: Record<string, string> },
  name: string
): string => `${built.addresses[name] ?? ""}.js`;

/** The kit's modules a build's pages load, all of them. */
const kitModulesOf = (built: { closure: { kitModules: string[] } }): string[] =>
  built.closure.kitModules;

/** A page that says `text`. */
const page = (text: string): Record<string, string> => ({
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router"; function Desk() {
  return <p>${text}</p>;
}
export const Route = createFileRoute("/")({ component: Desk });
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

/** Runs the clock's builds sweep at `at` until it has read every kind. */
const sweptAt = async (at: number): Promise<void> => {
  for (let run = 0; run < 24; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another, as the clock runs
    await sweepBuilds(env, new Date(at));
  }
};

// Every build starts an isolate with the compiler in it.
describe("page builds", { timeout: 60_000 }, () => {
  it("builds every page into modules that run on the kit's", async () => {
    const built = await buildPages(env, sampleApp, "app-test");
    if (!built.ok) {
      throw new Error(JSON.stringify(built.diagnostics, null, 2));
    }
    expect(built.diagnostics).toStrictEqual([]);

    // Evaluating the route tree at its address, with only the kit modules
    // the build names, links every import, the icons' too, without
    // `require`: every route, its component the page's.
    const tree = addressOf(built, built.entry);
    await expect(
      evaluate(
        {
          ...(await kitModulesNamed(kitModulesOf(built))),
          ...atAddresses(built),
        },
        [tree]
      )
    ).resolves.toMatchObject({ [tree]: { routeTree: "object" } });
    // The App's own classes, the kit's classes (quotes and all, from the
    // button's icon sizing) and the kit's theme.
    expect(built.css).toContain(".grid-cols-3");
    expect(built.css).toContain("svg:not([class*='size-'])");
    expect(built.css).toContain("--primary:");
  });

  it("names only the kit modules the App needs", async () => {
    const built = await buildPages(env, sampleApp, "app-test");

    expect(built.ok && kitModulesOf(built)).toContain(
      "lucide-react~icons~inbox.js"
    );
    expect(built.ok && kitModulesOf(built)).not.toContain(
      "lucide-react~icons~house.js"
    );
  });

  it("loads what the App's routes reach from their route tree, and nothing else of the App", async () => {
    const built = await buildPages(
      env,
      {
        ...sampleApp,
        "src/components/unused.tsx": "export const Unused = () => null;\n",
      },
      "app-test"
    );
    if (!built.ok) {
      throw new Error(JSON.stringify(built.diagnostics, null, 2));
    }
    expect({
      entry: built.entry,
      modules: built.closure.modules,
    }).toStrictEqual({
      entry: "app~src~routeTree.gen.js",
      modules: [
        "app~src~components~greeting.js",
        "app~src~components~icons.js",
        "app~src~routeTree.gen.js",
        "app~src~routes~__root.js",
        "app~src~routes~inbox.js",
        "app~src~routes~index.js",
      ],
    });
  });

  it("keeps every component of the kit available, and loads none a page doesn't import", async () => {
    const { modules } = await kitModules(env.ASSETS);
    const components = Object.keys(modules).filter((name) =>
      name.startsWith("@grasp-os~ui~components~")
    );
    const specifiers = components.map((name) =>
      name.slice(0, -".js".length).replaceAll("~", "/")
    );
    const built = await buildPages(
      env,
      {
        ...page("small"),
        "src/routes/all.tsx": `import { createFileRoute } from "@tanstack/react-router"; ${specifiers.map((specifier, index) => `import * as c${index} from "${specifier}";`).join("\n")}

function All() {
  return <p>{[${specifiers.map((_, index) => `c${index}`).join(", ")}].length}</p>;
}
export const Route = createFileRoute("/all")({ component: All });
`,
      },
      "app-test"
    );
    const small = await buildPages(env, page("small"), "app-test");
    if (!built.ok || !small.ok) {
      throw new Error(JSON.stringify(built.diagnostics, null, 2));
    }
    const route = addressOf(built, "app~src~routes~all.js");

    expect(components.length).toBeGreaterThan(0);
    expect(kitModulesOf(built)).toStrictEqual(
      expect.arrayContaining(components)
    );
    await expect(
      evaluate(
        {
          ...(await kitModulesNamed(kitModulesOf(built))),
          ...atAddresses(built),
        },
        [route]
      )
    ).resolves.toMatchObject({ [route]: { Route: "object" } });
    // An App whose pages import none of them loads none of them.
    expect(
      kitModulesOf(small).filter((name) => name.startsWith("@grasp-os~ui~"))
    ).toStrictEqual([]);
  });

  it("has the classes of the kit modules an App loads in its CSS, not the catalog's", async () => {
    // The sidebar's width, a class only the sidebar has.
    const sidebarClass = "w-\\(--sidebar-width\\)";
    const without = await buildPages(env, sampleApp, "app-test");
    const withSidebar = await buildPages(
      env,
      {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { Sidebar, SidebarProvider } from "@grasp-os/ui/components/sidebar";

function Desk() {
  return (
    <SidebarProvider>
      <Sidebar />
    </SidebarProvider>
  );
}
export const Route = createFileRoute("/")({ component: Desk });
`,
      },
      "app-test"
    );

    expect(without.ok && without.css).not.toContain(sidebarClass);
    expect(withSidebar.ok && withSidebar.css).toContain(sidebarClass);
  });

  it("has React DOM in the kit, for the page that renders pages", async () => {
    const { modules } = await kitModules(env.ASSETS);

    await expect(
      evaluate(modules, ["react-dom~client.js"])
    ).resolves.toMatchObject({
      "react-dom~client.js": { createRoot: "function" },
    });
  });

  it("runs pages through the React Compiler", async () => {
    const built = await buildPages(
      env,
      {
        "src/routes/counter.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { useState } from "react";

function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
export const Route = createFileRoute("/counter")({ component: Counter });
`,
      },
      "app-test"
    );

    expect(built.ok && built.modules["app~src~routes~counter.js"]).toContain(
      '"react~compiler-runtime.js"'
    );
  });

  it("refuses imports from outside the kit, saying where", async () => {
    const built = await buildPages(
      env,
      {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router"; import leftPad from "left-pad";
import { Dialog } from "@base-ui/react/dialog";
import { Nope } from "@grasp-os/ui/components/nope";
import { secret } from "../../outside";
import { InboxIcon, NotAnIcon } from "lucide-react";
import * as icons from "lucide-react";
export * from "lucide-react";

const remote = import("https://example.com/remote.js");

function Desk() {
  return <p>{leftPad(Dialog, Nope, secret, remote, InboxIcon, NotAnIcon, icons)}</p>;
}
export const Route = createFileRoute("/")({ component: Desk });
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
        'src/routes/index.tsx:1 imports: "left-pad" is outside the kit'
      ),
      expect.stringContaining(
        'src/routes/index.tsx:2 imports: "@base-ui/react/dialog" is outside the kit'
      ),
      expect.stringContaining(
        'src/routes/index.tsx:3 imports: "@grasp-os/ui/components/nope" is outside the kit'
      ),
      'src/routes/index.tsx:4 imports: "../../outside" is not a file in this App.',
      'src/routes/index.tsx:5 imports: "NotAnIcon" is not a lucide-react icon.',
      expect.stringContaining(
        "src/routes/index.tsx:6 imports: import or export icons from lucide-react by name"
      ),
      expect.stringContaining(
        "src/routes/index.tsx:7 imports: import or export icons from lucide-react by name"
      ),
      expect.stringContaining(
        'src/routes/index.tsx:9 imports: "https://example.com/remote.js" is outside the kit'
      ),
    ]);
  });

  it("takes a component's declaration file as types alone, never as a module", async () => {
    const built = await buildPages(
      env,
      {
        "src/routes/labels.tsx": `import { createFileRoute } from "@tanstack/react-router"; import type { Label } from "../components/labels";
import { Tag } from "../components/tag";

const label: Label = "urgent";

function Labels() {
  return <Tag label={label} />;
}
export const Route = createFileRoute("/labels")({ component: Labels });
`,
        "src/components/labels.d.ts": `export type Label = "urgent" | "later";
export declare const labels: readonly Label[];
`,
        // A module beside its declaration: a value import names the module.
        "src/components/tag.tsx": `export function Tag({ label }: { label: string }) {
  return <span>{label}</span>;
}
`,
        "src/components/tag.d.ts": `export declare function Tag(props: { label: string }): unknown;
`,
      },
      "app-test"
    );

    expect(
      built.ok ? Object.keys(built.modules).toSorted() : built
    ).toStrictEqual([
      "app~src~components~tag.js",
      "app~src~routeTree.gen.js",
      "app~src~routes~__root.js",
      "app~src~routes~labels.js",
    ]);
  });

  it("refuses a value import of a declaration file, which holds only types", async () => {
    const built = await buildPages(
      env,
      {
        "src/routes/labels.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { labels } from "../components/labels";
import { more } from "../components/labels.d.ts";
import { Ticket } from "../../server";
import { value } from "../components/value";

function Labels() {
  return <p>{[labels, more, Ticket, value].join()}</p>;
}
export const Route = createFileRoute("/labels")({ component: Labels });
`,
        // A folder module beside a declaration of the same name: TypeScript
        // reads the declaration first, so the page would run other code
        // than it was checked against.
        "src/components/value.d.ts": `export declare const value: string;
`,
        "src/components/value/index.ts": `export const value = 123;
`,
        "src/components/labels.d.ts": `export declare const labels: readonly string[];
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
      'src/routes/labels.tsx:1 imports: "../components/labels" is src/components/labels.d.ts, a declaration file: it holds only types, so import it with import type.',
      'src/routes/labels.tsx:2 imports: "../components/labels.d.ts" is src/components/labels.d.ts, a declaration file: it holds only types, so import it with import type.',
      'src/routes/labels.tsx:3 imports: "../../server" is server.d.ts, a declaration file: it holds only types, so import it with import type.',
      'src/routes/labels.tsx:4 imports: "../components/value" is src/components/value.d.ts, a declaration file: it holds only types, so import it with import type.',
    ]);
  });

  it("builds the same files once and serves them from the cache after", async () => {
    // Files of this test's own, so no earlier build is in the cache.
    const files = page(`once ${crypto.randomUUID()}`);
    // The isolates the build asked for, by kind: the compiler's and the
    // type checker's.
    const asked: string[] = [];
    const counting: WorkerLoader = {
      get: (name, code) => {
        asked.push(name?.split(":")[0] ?? "(unnamed)");
        return env.LOADER.get(name, code);
      },
      load: (code) => env.LOADER.load(code),
    };
    const built = await buildPages(
      { ...env, LOADER: counting },
      files,
      "app-test"
    );
    expect({ ok: built.ok, asked }).toStrictEqual({
      ok: true,
      asked: ["compiler", "check"],
    });

    // A build is its files': whichever App or version they come from, the
    // same files, next to any the build doesn't read, are built already.
    const cached = await buildPages(
      { ...env, LOADER: noBuilds },
      files,
      "app-test"
    );
    expect(cached).toStrictEqual(built);
    await expect(
      buildPages(
        { ...env, LOADER: noBuilds },
        { ...files, "server/notes.ts": "export {};\n" },
        "app-test"
      )
    ).resolves.toStrictEqual(built);

    // Other files it reads build again.
    await expect(
      buildPages(
        { ...env, LOADER: noBuilds },
        { ...files, "src/components/extra.ts": "export {};\n" },
        "app-test"
      )
    ).rejects.toThrow("Built again");
  });

  it("sweeps the per-file type checks earlier builds kept, which nothing writes any more", async () => {
    // Kept by builds before the check moved to its own isolate: never
    // read again, so the sweep empties them once their time is up.
    const key = `screen-checks/${crypto.randomUUID()}.json`;
    await env.FILES.put(key, "{}");
    await sweptAt(Date.now() + buildKeepMs + 24 * 60 * 60 * 1000);
    await expect(env.FILES.head(key)).resolves.toBeNull();
  });

  it("keeps a cached build while it is used, and builds one the sweep took again, the same", async () => {
    const files = page(`kept ${crypto.randomUUID()}`);
    const built = await buildPages(env, files, "app-test");
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
        const served = await buildPages(counted, files, "app-test");
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
    const kept = await buildPages(
      { ...env, LOADER: noBuilds },
      files,
      "app-test"
    );
    // Past its last use's time: gone.
    await sweptAt(refreshed + buildKeepMs + day);
    const swept = await buildPages(
      { ...env, LOADER: noBuilds },
      files,
      "app-test"
    ).then(
      () => "served",
      (error: unknown) => (error instanceof Error ? error.message : "")
    );
    const rebuilt = await buildPages(env, files, "app-test");
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
    const files = page(`unbounded ${crypto.randomUUID()}`);
    const built = await buildPages(env, files, "app-test");
    expect(built.ok).toBeTruthy();

    // On plain workerd with no sandbox and no opt-in (src/pages.ts).
    await expect(
      buildPages({ ...env, SANDBOX_IN_PROCESS: undefined }, files, "app-test")
    ).rejects.toThrow("No sandbox bounds App code here");
  });

  it("builds other files on their own", async () => {
    const first = await buildPages(env, page("first"), "app-test");
    const second = await buildPages(env, page("second"), "app-test");

    expect(first.ok && first.modules["app~src~routes~index.js"]).toContain(
      "first"
    );
    expect(second.ok && second.modules["app~src~routes~index.js"]).toContain(
      "second"
    );
  });
});
