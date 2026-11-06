import { appCompilerName, typeCheckerName } from "@grasp-os/compiler";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { buildPages } from "../src/pages.ts";
import { platformRunner } from "../src/platform-sandbox.ts";
import { unique } from "./sign-in.ts";

// A first pages build of a large App, after a release every App's, in
// calls within the compiler's CPU time per call (`compilerTaskCpuMs`), in
// an isolate of the App's own (pages.ts `transformInBatches`, the
// compiler's `startAppCompiler`). From its threat model:
// - One call transforms the whole App and the runtime stops it past its
//   CPU time: the build is kept as failed, and the App never builds again
//   until the next release.
// - A batch stopped at a bound fails the build, rather than being split,
//   or is tried again whole in a fresh isolate before it is split, paying
//   its CPU time twice at every split.
// - A build stopped part way starts again from nothing, and stops again.
// - A build its own paths refuse (a name clash) spends its batches first.
// - The isolate is named by the App's code: a Dynamic Worker billed per
//   unique name a day, and one kept for every version ever built.
// - Apps share one isolate on Cloudflare: one App's heavy builds stop
//   another's.
// - Each App keeps an isolate of its own on plain workerd, which unloads
//   no named isolate while the process runs: every App ever built holds a
//   compiler, until the process runs out of heap.
// Plain workerd enforces no CPU time: what bounds a call's is the source
// it is handed, held to a batch's characters (`batchCharacters` in
// pages.ts: 4 s at 45 µs a character); the runtime's message stands in
// for a stop, and `BUILD_BATCH_CPU_MS` sizes batches smaller to scale an
// App up.

/** A batch's characters at its 4 s of CPU time, at 45 µs a character. */
const batchCharacters = 88_888;

/** One call into the compiler's isolate: its method, what it was handed, whether it was stopped, how long it ran. */
interface Call {
  method: string;
  paths: string[];
  files: number;
  characters: number;
  stopped: boolean;
  ms: number;
}

/** Whether every transform call was held to `characters`, or was one file. */
const heldTo = (calls: readonly Call[], characters: number): boolean =>
  calls
    .filter(({ method }) => method === "transform")
    .every((call) => call.characters <= characters || call.files === 1);

/**
 * The files a compiler call was handed, each method's second argument: a
 * batch (`transform`), or the whole App.
 */
const handedOf = (args: unknown[]): Record<string, string> => {
  const [, handed] = args;
  return typeof handed === "object" && handed !== null
    ? Object.fromEntries(
        Object.entries(handed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {};
};

/** How the runtime ends a call it stopped past its CPU time. */
const cpuStop = "Worker exceeded CPU time limit.";

/**
 * Core's Loader, recording each isolate's name and each compiler call,
 * and ending the calls `fails` picks with the message it gives
 * (`cpuStop`, as the runtime stops one), once it has looked at the call.
 */
const recordingLoader = (
  fails: (
    method: string,
    handed: Record<string, string>
  ) => string | undefined | Promise<string | undefined> = () => {}
) => {
  const names: string[] = [];
  const calls: Call[] = [];
  let failed = 0;
  const watched = (entrypoint: object): object =>
    new Proxy(entrypoint, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (typeof property !== "string" || typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          const handed = handedOf(args);
          const call = {
            method: property,
            paths: Object.keys(handed).toSorted(),
            files: Object.keys(handed).length,
            characters: Object.values(handed).reduce(
              (sum, source) => sum + source.length,
              0
            ),
          };
          const failure = await fails(property, handed);
          if (failure !== undefined) {
            failed += 1;
            calls.push({ ...call, stopped: true, ms: 0 });
            throw new Error(failure);
          }
          const started = Date.now();
          const answer: unknown = await Reflect.apply(value, target, args);
          calls.push({ ...call, stopped: false, ms: Date.now() - started });
          return answer;
        };
      },
    });
  const worker = (stub: WorkerStub): WorkerStub =>
    new Proxy(stub, {
      get: (target, property): unknown =>
        property === "getEntrypoint"
          ? (...args: Parameters<WorkerStub["getEntrypoint"]>) =>
              watched(target.getEntrypoint(...args))
          : Reflect.get(target, property),
    });
  const loader: WorkerLoader = {
    get: (name, getCode) => {
      names.push(name ?? "");
      return worker(env.LOADER.get(name, getCode));
    },
    load: (code) => worker(env.LOADER.load(code)),
  };
  return { loader, names, calls, failed: () => failed };
};

/** A section of a page: state, a filtered list and a table, as Apps write them. */
const section = (page: number, index: number, tag: string): string => {
  const rows = Array.from(
    { length: 6 },
    (_, row) => `              <TableRow>
                <TableCell>Fixed ${page}.${index}.${row} ${tag}</TableCell>
                <TableCell>{${row * 3}}</TableCell>
                <TableCell>
                  <Badge>Kept</Badge>
                </TableCell>
              </TableRow>`
  ).join("\n");
  return `
const Section${index} = ({
  entries,
  onToggle,
}: {
  entries: Entry[];
  onToggle: (id: string) => void;
}) => {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(true);
  const shown = entries.filter((entry) => entry.name.includes(filter));
  const total = shown.reduce((sum, entry) => sum + entry.count, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Section ${page}.${index}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          <Input
            aria-label="Filter section ${index}"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
          <Button
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? "Hide" : "Show"} {total}
          </Button>
          {open ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Count</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.name}</TableCell>
                  <TableCell>{entry.count}</TableCell>
                  <TableCell>
                    <Button
                      onClick={() => {
                        onToggle(entry.id);
                      }}
                    >
                      {entry.done ? "Reopen" : "Finish"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
${rows}
            </TableBody>
          </Table>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
};
`;
};

/**
 * One of a synthetic App's pages, of `sections` sections. Its route says
 * the path it had before its file was renamed: TanStack's generator
 * corrects it, and what compiles is what the tree routes.
 */
const page = (index: number, sections: number, tag: string): string => {
  const names = Array.from({ length: sections }, (_, each) => each);
  return `import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { useState } from "react";

import { Panel } from "../components/panel";
import type { Entry } from "../components/panel";

${names.map((each) => section(index, each, tag)).join("")}
function Page${index}() {
  const [entries, setEntries] = useState<Entry[]>([
    { id: "a", name: "First ${tag}", count: 1, done: false },
    { id: "b", name: "Second", count: 2, done: true },
  ]);
  const toggle = (id: string) => {
    setEntries(
      entries.map((entry) =>
        entry.id === id ? { ...entry, done: !entry.done } : entry
      )
    );
  };
  return (
    <main className="flex flex-col gap-4">
      <Panel title="Page ${index}" />
${names.map((each) => `      <Section${each} entries={entries} onToggle={toggle} />`).join("\n")}
    </main>
  );
}
export const Route = createFileRoute("/page-${index}")({ component: Page${index} });
`;
};

/** The component every page of a synthetic App imports. */
const panel = (tag: string): string => `// ${tag}
export interface Entry {
  id: string;
  name: string;
  count: number;
  done: boolean;
}

export function Panel({ title }: { title: string }) {
  return <h2 className="text-lg">{title}</h2>;
}
`;

/** A synthetic App of `pages` pages of `sections` sections each, of this test's own. */
const syntheticApp = (
  pages: number,
  sections: number
): Record<string, string> => {
  const tag = unique();
  return {
    "src/components/panel.tsx": panel(tag),
    ...Object.fromEntries(
      Array.from({ length: pages }, (_, index) => [
        `src/routes/s${String(index).padStart(2, "0")}.tsx`,
        page(index, sections, tag),
      ])
    ),
  };
};

/** The total characters of `files`. */
const charactersOf = (files: Record<string, string>): number =>
  Object.values(files).reduce((sum, source) => sum + source.length, 0);

/** What each pages build logged of its batches while `build` ran. */
const batchesLogged = async (build: () => Promise<unknown>) => {
  const info = vi.spyOn(console, "info");
  try {
    await build();
    return info.mock.calls
      .map(([logged]: unknown[]) => logged)
      .filter(
        (logged): logged is Record<string, unknown> =>
          typeof logged === "object" &&
          logged !== null &&
          "event" in logged &&
          logged.event === "build.compile"
      )
      .map(({ batchCalls, batched, compiled, reused }) => ({
        batchCalls,
        batched,
        compiled,
        reused,
      }));
  } finally {
    info.mockRestore();
  }
};

describe("a first pages build of a large App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transforms an App four times a 60-page App's size in calls each held to a batch", async () => {
    // A 60-page App at today's limit, in batches of a quarter of their
    // size (1 s of CPU time, against 4 s), as a 240-page App is batched.
    const quarter = Math.floor(batchCharacters / 4);
    const files = syntheticApp(60, 4);
    const { loader, calls } = recordingLoader();

    const built = await buildPages(
      {
        ...env,
        LOADER: loader,
        RUNTIME_PROFILE: "cloudflare",
        BUILD_BATCH_CPU_MS: "1000",
      },
      files,
      `app-${unique()}`
    );

    const transforms = calls.filter(({ method }) => method === "transform");
    // For the record only: wall times here say little of Cloudflare's CPU.
    console.log(
      "page-batches",
      JSON.stringify({
        characters: charactersOf(files),
        transforms: transforms.length,
        slowestTransformMs: Math.max(...transforms.map(({ ms }) => ms)),
        builds: calls
          .filter(({ method }) => method !== "transform")
          .map(({ method, ms }) => ({ method, ms })),
      })
    );
    expect({
      ok: built.ok,
      atTheLimit: charactersOf(files) > 800_000,
      batched: transforms.length > 1,
      // Its files, and the root route the build adds.
      everyFileOnce:
        transforms.reduce((sum, { files: count }) => sum + count, 0) ===
        Object.keys(files).length + 1,
      heldToABatch: heldTo(calls, quarter),
    }).toStrictEqual({
      ok: true,
      atTheLimit: true,
      batched: true,
      everyFileOnce: true,
      heldToABatch: true,
    });
  }, 300_000);

  it("splits a batch stopped at its CPU time, each part tried once, and resumes a build stopped part way", async () => {
    // Batches as production sizes them: about 89,000 characters, some six
    // of these pages each.
    const files = syntheticApp(8, 4);
    // Its files, and the root route the build adds (it has none of its own).
    const count = Object.keys(files).length + 1;
    const whose = `app-${unique()}`;
    const onCloudflare = { ...env, RUNTIME_PROFILE: "cloudflare" };
    // Every batch of several files stops, and the build's own call ends
    // before it answers, as when its request is cancelled.
    const stopping = recordingLoader((method, handed) => {
      if (method === "transform") {
        return Object.keys(handed).length > 1 ? cpuStop : undefined;
      }
      return method === "buildIncrementally"
        ? "The request was cancelled."
        : undefined;
    });
    const stopped = await batchesLogged(async () => {
      const ended = await buildPages(
        { ...onCloudflare, LOADER: stopping.loader },
        files,
        whose
      ).catch((error: unknown) => error);
      expect(ended).toBeInstanceOf(Error);
    });
    // How long the build's lease still holds as its type check starts.
    let leaseLeftAtCheck = 0;
    const after = recordingLoader(async (method) => {
      if (method === "check") {
        const row = await env.DB.prepare(
          "SELECT MAX(lease_expires_at) AS expires FROM build_receipts WHERE key LIKE 'page-builds/%' AND holder IS NOT NULL"
        ).first<{ expires: number | null }>();
        leaseLeftAtCheck = (row?.expires ?? 0) - Date.now();
      }
    });

    let routes: string[] = [];
    const resumed = await batchesLogged(async () => {
      const built = await buildPages(
        { ...onCloudflare, LOADER: after.loader },
        files,
        whose
      );
      expect(built.ok).toBeTruthy();
      // Each page as the batches made it: its route at its file's path.
      routes = built.ok
        ? Object.entries(built.modules)
            .filter(([name]) => name.startsWith("app~src~routes~s"))
            .map(
              ([, code]) =>
                /createFileRoute\("(?<path>[^"]*)"\)/u.exec(code)?.groups
                  ?.path ?? ""
            )
        : [];
    });

    const transforms = stopping.calls.filter(
      ({ method }) => method === "transform"
    );
    const tried = transforms.map(({ paths }) => paths.join("\n"));
    expect({
      batched: charactersOf(files) > batchCharacters,
      heldToABatch: heldTo(stopping.calls, batchCharacters),
      batchesStopped: transforms.some(({ stopped: was }) => was),
      // No part tried twice: a stop splits it, never retries it whole.
      eachTriedOnce: new Set(tried).size === tried.length,
      split: transforms
        .filter(({ stopped: was }) => !was)
        .map(({ files: one }) => one),
      stopped,
      resumed,
      routes: routes.toSorted(),
      calls: after.calls.map(({ method }) => method),
      // The check is a call of its own: the lease is renewed as it starts,
      // for as long as it may take, so no other request builds it again.
      leaseHoldsTheCheck:
        leaseLeftAtCheck >=
        platformRunner(onCloudflare, whose).callMs("type-checker"),
    }).toStrictEqual({
      batched: true,
      heldToABatch: true,
      batchesStopped: true,
      eachTriedOnce: true,
      // Every batch of several stopped, and split down to one file each.
      split: Array.from({ length: count }, () => 1),
      // The build ended before it logged.
      stopped: [],
      // Nothing transformed again: the stopped build's batches were kept,
      // its pages among them, whose routes the generator corrected.
      resumed: [{ batchCalls: 0, batched: 0, compiled: 0, reused: count }],
      routes: Array.from(
        { length: 8 },
        (_, index) => `/s${String(index).padStart(2, "0")}`
      ),
      // The build's own call, then its one type check, in the checker.
      calls: ["buildIncrementally", "check"],
      leaseHoldsTheCheck: true,
    });
  }, 120_000);

  it("hashes an App's files as often however many batches its build takes", async () => {
    // Core's hashes during a build of an App of its own in batches sized
    // to `cpuMs`: its keys, its records', its build's.
    const hashesIn = async (cpuMs: string) => {
      const { loader, calls } = recordingLoader();
      const files = syntheticApp(6, 1);
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        const built = await buildPages(
          {
            ...env,
            LOADER: loader,
            RUNTIME_PROFILE: "cloudflare",
            BUILD_BATCH_CPU_MS: cpuMs,
          },
          files,
          `app-${unique()}`
        );
        expect(built.ok).toBeTruthy();
        return {
          hashes: digest.mock.calls.length,
          batches: calls.filter(({ method }) => method === "transform").length,
        };
      } finally {
        digest.mockRestore();
      }
    };

    // A batch per file, then about a batch per three.
    const many = await hashesIn("10");
    const few = await hashesIn("600");

    expect({
      fewerBatches: few.batches < many.batches,
      sameHashes: many.hashes === few.hashes,
    }).toStrictEqual({ fewerBatches: true, sameHashes: true });
  }, 120_000);

  it("refuses an App its paths refuse before it spends a batch", async () => {
    const files = {
      ...syntheticApp(8, 4),
      // Both would be the module `src/components/panel`.
      "src/components/panel.ts": "export const panel = 1;\n",
    };
    const { loader, calls } = recordingLoader();

    const built = await buildPages(
      { ...env, LOADER: loader, RUNTIME_PROFILE: "cloudflare" },
      files,
      `app-${unique()}`
    );

    expect({
      batched: charactersOf(files) > batchCharacters,
      refused: built.ok ? [] : built.diagnostics.map(({ rule }) => rule),
      calls: calls.map(({ method }) => method),
    }).toStrictEqual({
      batched: true,
      refused: ["file-names"],
      calls: ["buildIncrementally"],
    });
  }, 120_000);

  it("names the App's compiler isolate by the App and the release, never by its code", async () => {
    const whose = `app-${unique()}`;
    const first = syntheticApp(2, 1);
    const changed = syntheticApp(2, 1);
    const { loader, names } = recordingLoader();
    const onCloudflare = {
      ...env,
      LOADER: loader,
      RUNTIME_PROFILE: "cloudflare",
    };

    await buildPages(onCloudflare, first, whose);
    await buildPages(onCloudflare, changed, whose);
    await buildPages(
      { ...onCloudflare, BUILD_BATCH_CPU_MS: "10" },
      syntheticApp(3, 1),
      whose
    );

    const sources = [first, changed].flatMap((files) => Object.values(files));
    // The compiler's isolates, and the type checker's, which every App
    // shares (its name is the release's alone).
    const [compilers, checkers] = [
      names.filter((name) => !name.startsWith(typeCheckerName)),
      names.filter((name) => name.startsWith(typeCheckerName)),
    ];
    expect({
      names: [...new Set(compilers)].map((name) =>
        name.startsWith(appCompilerName(whose))
      ),
      checked: checkers.length > 0,
      code: names.filter((name) =>
        sources.some((source) =>
          source
            .split("\n")
            .some((line) => line.length > 8 && name.includes(line))
        )
      ),
    }).toStrictEqual({ names: [true], checked: true, code: [] });
  }, 120_000);

  it("builds every App in one compiler isolate on plain workerd", async () => {
    const { loader, names } = recordingLoader();
    const onWorkerd = { ...env, LOADER: loader, RUNTIME_PROFILE: "workerd" };

    const first = await buildPages(
      onWorkerd,
      syntheticApp(2, 1),
      `app-${unique()}`
    );
    const second = await buildPages(
      onWorkerd,
      syntheticApp(2, 1),
      `app-${unique()}`
    );

    // Core's Loader suffixes each name with the entrypoint it silences.
    // The type checker's isolate is every App's anywhere, a release's own.
    const isolates = new Set(
      names
        .map((name) => name.split("\u0000")[0])
        .filter((name) => name?.startsWith(typeCheckerName) === false)
    );
    expect({
      built: [first.ok, second.ok],
      isolates: [...isolates],
    }).toStrictEqual({ built: [true, true], isolates: [appCompilerName()] });
  }, 120_000);
});
