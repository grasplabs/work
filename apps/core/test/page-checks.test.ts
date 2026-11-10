import {
  isDesignRule,
  startAppCompiler,
  startTypeChecker,
  startUltracite,
} from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import { generatedPaths, symbolicModules } from "@grasp-os/runtime/host";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { buildPages } from "../src/pages.ts";
import { callStub } from "../src/sandboxed.ts";
import { designCases, designFindings } from "./design-cases.ts";

/** A typical page: a list with a filter, on the kit, with its own component. */
const typicalApp: Record<string, string> = {
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { Status } from "../components/status";
import type { Ticket } from "../../server";

const tickets: Ticket[] = [
  { id: "T-1", title: "Printer on fire", status: "open", assignee: "Ada" },
  { id: "T-2", title: "VPN drops at noon", status: "waiting", assignee: null },
  { id: "T-3", title: "New laptop", status: "closed", assignee: "Grace" },
];

function Tickets() {
  const [query, setQuery] = useState("");
  const shown = tickets.filter((ticket) =>
    ticket.title.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <main className="flex flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Tickets</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <SearchIcon aria-hidden />
            <Input
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button size="sm">
              <PlusIcon aria-hidden /> New
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticket</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assignee</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((ticket) => (
                <TableRow key={ticket.id}>
                  <TableCell>{ticket.title}</TableCell>
                  <TableCell>
                    <Status status={ticket.status} />
                  </TableCell>
                  <TableCell>
                    {ticket.assignee ?? <Badge variant="outline">Unassigned</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
export const Route = createFileRoute("/")({ component: Tickets });
`,
  "src/components/status.tsx": `import { Badge } from "@grasp-os/ui/components/badge";

import type { Ticket } from "../../server";

const variants = {
  open: "default",
  waiting: "secondary",
  closed: "outline",
} as const;

export function Status({ status }: { status: Ticket["status"] }) {
  return <Badge variant={variants[status]}>{status}</Badge>;
}
`,
  // The App's server types, which pages use but don't compile.
  "server.d.ts": `export type { ReactNode } from "react";

export interface Ticket {
  id: string;
  title: string;
  status: "open" | "waiting" | "closed";
  assignee: string | null;
}
`,
};

/** The typical App with `files` added or replaced. */
const app = (files: Record<string, string>): Record<string, string> => ({
  ...typicalApp,
  ...files,
});

/** Where a diagnostic is, what found it and what it says, on one line. */
const summary = ({ file, line, column, rule, severity, message }: Diagnostic) =>
  `${file}:${line}:${column} ${rule} ${severity}: ${message}`;

/** The typical page, with one line of it changed. */
const withLine = (from: string, to: string): Record<string, string> => {
  const page = typicalApp["src/routes/index.tsx"] ?? "";
  if (!page.includes(from)) {
    throw new Error(`The page has no ${from}`);
  }
  return { "src/routes/index.tsx": page.replace(from, to) };
};

/**
 * What the pages' own lint rules (the compiler's page-rules.ts) find in
 * `files`, in the lint's isolate (Ultracite's `lint`), and whether it
 * passes.
 */
const designLint = async (
  files: Record<string, string>
): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> => {
  const linted = await startUltracite(env.LOADER, env.ASSETS).lint(files);
  const diagnostics = Object.keys(linted)
    .toSorted()
    .flatMap((path) => linted[path] ?? [])
    .filter(({ rule }) => isDesignRule(rule));
  return {
    ok: diagnostics.every(({ severity }) => severity !== "error"),
    diagnostics,
  };
};

/** What a checked build of `files`' pages says of their classes (the compiler's classes.ts). */
const classChecks = async (
  files: Record<string, string>
): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> => {
  const built = await buildPages(env, files, "app-test");
  return {
    ok: built.ok,
    diagnostics: built.diagnostics.filter(({ rule }) => isDesignRule(rule)),
  };
};

// Every build starts an isolate with the compiler in it.
describe("page checks", { timeout: 60_000 }, () => {
  it("passes a clean page, with the App's server types", async () => {
    const built = await buildPages(env, app({}), "app-test");

    expect(built).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("fails a type error, saying where", async () => {
    const built = await buildPages(
      env,
      app(
        withLine(
          `{ id: "T-2", title: "VPN drops at noon", status: "waiting", assignee: null },`,
          `{ id: "T-2", title: "VPN drops at noon", status: "stuck", assignee: null },`
        )
      ),
      "app-test"
    );

    expect(built).toStrictEqual({
      ok: false,
      diagnostics: [
        {
          file: "src/routes/index.tsx",
          line: 21,
          column: 44,
          rule: "TS2322",
          severity: "error",
          message: `Type '"stuck"' is not assignable to type '"closed" | "open" | "waiting"'.`,
        },
      ],
    });
  });

  it("fails a page that calls an App's server, which no page reaches", async () => {
    const built = await buildPages(
      env,
      app({
        "server/tickets.ts": `export const secret = (): string => "fictional-marker";\n`,
        "src/routes/server.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { secret } from "../../server/tickets.ts";

function Server() {
  return <button type="button" onClick={() => void secret()}>Go</button>;
}
export const Route = createFileRoute("/server")({ component: Server });
`,
      }),
      "app-test"
    );

    expect({
      ok: built.ok,
      files: [...new Set(built.diagnostics.map(({ file }) => file))],
      serverCode: built.diagnostics.some(({ message }) =>
        message.includes("is the App's server code")
      ),
    }).toStrictEqual({
      ok: false,
      files: ["src/routes/server.tsx"],
      serverCode: true,
    });
  });

  it("fails a page that names the App's server code in a reference directive, though its build reads it for types", async () => {
    const built = await buildPages(
      env,
      app({
        // References, so the build reads the server code for their types.
        "server/_generated/api.ts": "export const api = {};\n",
        "server/tickets.ts": `export const secret = (): string => "fictional-marker";\n`,
        "src/routes/server.tsx": `/// <reference path="../../server/tickets.ts" />
import { createFileRoute } from "@tanstack/react-router";

function Server() {
  return null;
}
export const Route = createFileRoute("/server")({ component: Server });
`,
      }),
      "app-test"
    );
    expect({
      ok: built.ok,
      files: [...new Set(built.diagnostics.map(({ file }) => file))],
    }).toStrictEqual({ ok: false, files: ["src/routes/server.tsx"] });
  });

  it("fails a type error in the App's server types", async () => {
    const built = await buildPages(
      env,
      app({
        "server.d.ts": `export interface Ticket {
  id: string;
  title: string;
  status: "open" | "waiting" | "closed";
  assignee: Person | null;
}
`,
      }),
      "app-test"
    );

    expect(built).toStrictEqual({
      ok: false,
      diagnostics: [
        {
          file: "server.d.ts",
          line: 5,
          column: 13,
          rule: "TS2304",
          severity: "error",
          message: "Cannot find name 'Person'.",
        },
      ],
    });
  });

  it("fails a syntax error, saying where", async () => {
    const built = await buildPages(
      env,
      app(
        withLine(
          `const [query, setQuery] = useState("");`,
          'const [query, setQuery = useState("");'
        )
      ),
      "app-test"
    );

    expect(built.ok).toBeFalsy();
    expect(
      built.diagnostics.map((diagnostic) => summary(diagnostic))
    ).toStrictEqual([
      expect.stringMatching(
        /^src\/routes\/index\.tsx:26:40 compile error: Expected `,` or `\]` but found `;`/u
      ),
    ]);
    expect(built.diagnostics[0]?.rule).toBe("compile");
  });

  it("fails a compile error and a type error in one build, none hiding another, the classes of what compiles checked", async () => {
    const built = await buildPages(
      env,
      app({
        ...withLine(
          `{ id: "T-2", title: "VPN drops at noon", status: "waiting", assignee: null },`,
          `{ id: "T-2", title: "VPN drops at noon", status: "stuck", assignee: null },`
        ),
        // A hook called on a condition, which the React Compiler refuses.
        "src/routes/when.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { useState } from "react";
import { Button } from "@grasp-os/ui/components/button";

const nothing = (): void => undefined;

function When() {
  const open = window.innerWidth > 0;
  if (open) {
    useState(0);
  }
  // TS1345: a type check of a file that parses, though its code is TS1xxx.
  if (nothing()) {
    return null;
  }
  return <Button className="rounded-full">Go</Button>;
}
export const Route = createFileRoute("/when")({ component: When });
`,
      }),
      "app-test"
    );

    expect({
      ok: built.ok,
      found: built.diagnostics
        .filter(({ severity }) => severity === "error")
        .map(({ file, rule }) => `${file} ${rule}`)
        .toSorted(),
    }).toStrictEqual({
      ok: false,
      found: [
        "src/routes/index.tsx TS2322",
        "src/routes/when.tsx TS1345",
        "src/routes/when.tsx compile",
      ],
    });
  });

  it("checks a page against the stand-ins for its server's references with every kind of call, reporting only its own untyped parameters", async () => {
    // While the server code doesn't register, `@server/_generated/api` is a stand-in
    // (symbolicModules): a query, a mutation, a stream and a paged query
    // through it type-check, and callbacks over what they answer take
    // their type from it. A helper's untyped parameter is still reported.
    const built = await buildPages(
      env,
      app({
        [generatedPaths.api]: symbolicModules()[generatedPaths.api] ?? "",
        "src/routes/writer.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { useMutation, usePaginatedQuery, useQuery, useStream } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";

import { api } from "@server/_generated/api";

const shout = (text) => String(text).toUpperCase();

function Writer() {
  const notes = useQuery(api.notes.list, {});
  const pages = usePaginatedQuery(api.notes.page, {}, { initialPageSize: 10 });
  const save = useMutation(api.notes.save);
  const draft = useStream(api.writer.draft);
  if (notes === undefined) {
    return <p>Loading</p>;
  }
  return (
    <main className="flex flex-col gap-2">
      {notes.items.map((note) => (
        <p key={note.id}>{shout(note.title)}</p>
      ))}
      {pages.items.map(({ id, title }) => (
        <p key={id}>{title}</p>
      ))}
      <p>{draft.status === "running" ? String(draft.progress?.text) : ""}</p>
      <Button onClick={() => void save({ title: "New" })}>Save</Button>
      <Button onClick={() => void draft.run({ topic: "notes" })}>Draft</Button>
    </main>
  );
}
export const Route = createFileRoute("/writer")({ component: Writer });
`,
      }),
      "app-test"
    );

    expect(
      built.diagnostics
        .filter(({ severity }) => severity === "error")
        .map(({ file, line, rule }) => `${file}:${line} ${rule}`)
    ).toStrictEqual(["src/routes/writer.tsx:6 TS7006"]);
  });

  it("checks a typical page quickly once the checker's isolate is warm", async () => {
    const { request } = z
      .object({ typeCheck: z.object({ request: z.unknown() }) })
      .parse(
        await callStub(
          startAppCompiler(env.LOADER, env.ASSETS, "app-test"),
          "build",
          ["pages", typicalApp]
        )
      ).typeCheck;
    const checker = startTypeChecker(env.LOADER, env.ASSETS);
    await expect(callStub(checker, "check", [request])).resolves.toStrictEqual(
      []
    );

    // The fastest of a few runs: a shared runner's pauses (other jobs,
    // garbage collection) only ever add time. A warm check takes about
    // 100 ms on a laptop, well inside the 1 s the checks may add to a
    // build; the bound here is looser, 5 s, so that a slow or busy CI
    // runner can't fail it, while a check gone badly wrong (runaway work)
    // still does. The test's clock only moves on I/O; each RPC to the
    // checker is I/O, so the times are real.
    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- runs are timed one at a time
      await callStub(checker, "check", [request]);
      timings.push(performance.now() - started);
    }

    expect(Math.min(...timings)).toBeLessThan(5000);
  });
});

// The design system's checks of a page's classes, in its build's Tailwind
// step (packages/compiler/src/classes.ts): they fail the checked builds,
// as the type check does, never the preview's frame.
describe("the design system's class checks", { timeout: 60_000 }, () => {
  it("fails the checked builds of a restyled kit component, never the preview's frame", async () => {
    const files = app(
      withLine(
        `<Button size="sm">`,
        `<Button size="sm" className="rounded-full">`
      )
    );

    const [built, checked, framed] = await Promise.all([
      buildPages(env, files, "app-test"),
      buildPages(env, files, "app-test", { profile: "preview" }),
      buildPages(env, files, "app-test", { profile: "preview", checks: false }),
    ]);

    expect({
      built: built.ok,
      checked: checked.ok,
      framed: framed.ok,
      found: built.diagnostics
        .filter(({ rule }) => isDesignRule(rule))
        .map(({ file, rule }) => `${file} ${rule}`),
    }).toStrictEqual({
      built: false,
      checked: false,
      framed: true,
      found: ["src/routes/index.tsx design/no-restyle"],
    });
  });

  it("fails a restyled component where it is, naming what it owns and its variants", async () => {
    const checked = await classChecks(
      app(
        withLine(
          `<Button size="sm">`,
          `<Button size="sm" className="mt-2 rounded-full px-8">`
        )
      )
    );

    expect(checked.ok).toBeFalsy();
    expect(
      checked.diagnostics.map((diagnostic) => summary(diagnostic))
    ).toStrictEqual([
      expect.stringContaining(
        'src/routes/index.tsx:44:47 design/no-restyle error: "rounded-full" is not allowed on <Button>: <Button> owns its shape. Pick one of its variants instead: variant (default, outline, secondary, ghost, destructive, link, hint, ask, highlight); size (default, xs, sm, lg, xl, icon, icon-xs, icon-sm, icon-lg, inline).'
      ),
      expect.stringContaining(
        'src/routes/index.tsx:44:60 design/no-restyle error: "px-8" is not allowed on <Button>: <Button> owns its spacing.'
      ),
    ]);
  });

  it("knows the kit's own classes, and names the nearest of a misspelt one", async () => {
    const checked = await classChecks(
      app({
        "src/components/kit-classes.tsx": `import { cn } from "@grasp-os/ui/lib/utils";

export const KitClasses = ({ on }: { on: boolean }) => (
  <p className={cn("flex animate-in fade-in ease-house type-display group", on && "itmes-center")}>
    Kit
  </p>
);
`,
      })
    );
    // Wherever a class goes: kept in a variable through \`cn\`, an object's
    // keys, a template's text and its branches.
    const elsewhere = await classChecks(
      app({
        "src/components/tones.tsx": `import { cn } from "@grasp-os/ui/lib/utils";

const tone = cn("flex no-such-base", { "no-such-key": true });

export const Tone = ({ on }: { on: boolean }) => (
  <span className={\`\${tone} inline-flex \${on ? "gap-1" : "no-such-branch"}\`}>
    Tone
  </span>
);
`,
      })
    );

    // The theme's \`ease-house\`, tw-animate-css's \`animate-in\` and
    // \`fade-in\` and the kit's own \`type-display\` are classes the kit
    // has, and \`group\` marks an element for its children's variants.
    expect(
      checked.diagnostics.map(({ rule, message, fix }) => ({
        rule,
        message,
        fix,
      }))
    ).toStrictEqual([
      {
        rule: "design/no-unknown-classes",
        message:
          '"itmes-center" is not a class the kit\'s Tailwind knows, so no CSS is generated for it. Did you mean "items-center"?',
        fix: 'Replace with "items-center".',
      },
    ]);
    expect(
      elsewhere.diagnostics.map(({ rule, message }) => [
        rule,
        message.slice(0, message.indexOf(" is not")),
      ])
    ).toStrictEqual([
      ["design/no-unknown-classes", '"no-such-branch"'],
      ["design/no-unknown-classes", '"no-such-base"'],
      ["design/no-unknown-classes", '"no-such-key"'],
    ]);
  });

  it("reports a thousand unknown classes within a build's time, suggesting for the first few", async () => {
    const classes = Array.from(
      { length: 1000 },
      (_, index) => `zz-unknown-${index}`
    );
    const started = performance.now();
    const checked = await classChecks(
      app({
        "src/components/many.tsx": `export const Many = () => <p className="${classes.join(" ")}">Many</p>;\n`,
      })
    );
    const ms = performance.now() - started;

    expect({
      ok: checked.ok,
      unknown: checked.diagnostics.filter(
        ({ rule }) => rule === "design/no-unknown-classes"
      ).length,
      // Each look for the nearest reads every class Tailwind knows: a
      // build looks for 20 at most.
      lookedFor:
        checked.diagnostics.filter(({ message }) =>
          message.includes("Fix the spelling")
        ).length >= 980,
      // A thousand looks took minutes; the call's CPU time stopped it.
      fast: ms < 30_000,
    }).toStrictEqual({ ok: false, unknown: 1000, lookedFor: true, fast: true });
  });

  it("fails a raw colour and an arbitrary value, naming the theme's colours and the scale", async () => {
    const checked = await classChecks(
      app(
        withLine(
          `<main className="flex flex-col gap-4 p-6">`,
          `<main className="flex flex-col gap-4 bg-red-500 p-[24px]">`
        )
      )
    );

    expect(checked.ok).toBeFalsy();
    expect(
      checked.diagnostics.map((diagnostic) => summary(diagnostic))
    ).toStrictEqual([
      expect.stringContaining(
        "src/routes/index.tsx:31:42 design/no-raw-colors error: \"bg-red-500\" uses Tailwind's palette (red-500), not the kit's theme. Use one of the theme's colours: "
      ),
      expect.stringContaining(
        'src/routes/index.tsx:31:53 design/no-arbitrary-values error: "p-[24px]" hardcodes a value off the kit\'s theme. Use "p-6" instead (the same value, on the scale).'
      ),
    ]);
    expect(checked.diagnostics[0]?.message).toContain("destructive");
  });

  it("passes classes that only look like a page's own, and strings that aren't classes", async () => {
    const checked = await classChecks(
      app({
        "src/routes/lookalikes.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { cn } from "@grasp-os/ui/lib/utils";

function Lookalikes() {
  const notice = window.location.hash === "#saved";
  const style = notice ? "Wow!" : "Plain";
  return (
    <section aria-label="Saved!" title={style}>
      <p className={cn({ "font-bold": notice && "Saved!" }, notice || "gap-2")}>{style}</p>
      <p className={cn({ "text-muted-foreground": style === "Wow!" })}>{style}!</p>
    </section>
  );
}
export const Route = createFileRoute("/lookalikes")({ component: Lookalikes });
`,
      })
    );

    expect(checked).toMatchObject({ ok: true, diagnostics: [] });
  });
});

// The pages' own lint rules (packages/compiler/src/page-rules.ts), part of
// Ultracite's lint: what they find blocks a proposal, never a build or a
// preview (agent-builds.test.ts, draft-proposals.test.ts).
describe("the pages' lint", { timeout: 60_000 }, () => {
  it("reads disable comments as oxlint does, as an exported App's lint does", async () => {
    const linted = await designLint(app(designCases));

    expect({
      ok: linted.ok,
      found: linted.diagnostics.map(({ file, rule }) => `${file} ${rule}`),
    }).toStrictEqual({ ok: false, found: designFindings });
  });

  it("fails a page that names WebRTC or makes a nested document, saying what to do", async () => {
    const linted = await designLint(
      app({
        "src/routes/peers.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { useEffect, useRef } from "react";

function Peers() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const connection = new RTCPeerConnection();
    const channel = new RTCDataChannel();
    const nested = document.querySelector("iframe");
    const realm = nested?.contentWindow;
    void [connection, channel, realm, box];
  }, []);
  return (
    <div ref={box}>
      <iframe title="nested" sandbox="" />
    </div>
  );
}
export const Route = createFileRoute("/peers")({ component: Peers });
`,
      })
    );

    expect(linted.ok).toBeFalsy();
    expect(
      linted.diagnostics.map(({ line, rule }) => `${line} ${rule}`)
    ).toStrictEqual([
      "6 no-restricted-globals",
      "7 no-restricted-globals",
      "9 no-restricted-properties",
      "14 react/forbid-elements",
    ]);
    // Each says what to do instead.
    expect(
      linted.diagnostics.every(({ message, fix }) =>
        `${message} ${fix ?? ""}`.includes("through its App's functions")
      )
    ).toBeTruthy();
  });

  it("fails a plain form and an inline style, naming the kit's form and its classes", async () => {
    const linted = await designLint(
      app({
        "src/routes/ask.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { Button } from "@grasp-os/ui/components/button";

function Ask() {
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <p style={{ color: "red" }}>Ask</p>
      <Button style={{ margin: 0 }} type="submit">Ask</Button>
    </form>
  );
}
export const Route = createFileRoute("/ask")({ component: Ask });
`,
      })
    );

    expect({
      ok: linted.ok,
      found: linted.diagnostics.map(({ line, column, rule, message, fix }) => ({
        at: `${line}:${column}`,
        rule,
        says: `${message} ${fix ?? ""}`.includes(
          rule === "react/forbid-elements"
            ? "@grasp-os/ui/form"
            : "theme classes"
        ),
      })),
    }).toStrictEqual({
      ok: false,
      found: [
        { at: "5:6", rule: "react/forbid-elements", says: true },
        { at: "6:10", rule: "react/forbid-dom-props", says: true },
        { at: "7:15", rule: "react/forbid-component-props", says: true },
      ],
    });
  });

  it("passes a page that names the window's members, or only looks like WebRTC", async () => {
    const linted = await designLint(
      app({
        "src/routes/windowed.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { useEffect, useState } from "react";

const peers = { RTCMode: "relay", connection: "PeerConnection" };

function Windowed() {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    setWidth(window.innerWidth);
    const saved = window["localStorage"].getItem("draft");
    const frame = document.createElement("div");
    const key = "draft";
    void [saved, frame, typeof window, globalThis.location.hash, Object.keys(window).length, window.localStorage[key]];
  }, []);
  return (
    <p>
      {width} {peers.RTCMode} {peers.connection}
    </p>
  );
}
export const Route = createFileRoute("/windowed")({ component: Windowed });
`,
      })
    );

    expect(linted).toMatchObject({ ok: true, diagnostics: [] });
  });
});

describe("the App compiler's surface", { timeout: 60_000 }, () => {
  it("never passes a page its build refuses for an import, however clean its type check", async () => {
    const leaking = {
      ...typicalApp,
      "src/routes/leak.tsx":
        'import { createFileRoute } from "@tanstack/react-router"; import { createClient } from "@grasp-os/runtime/page";\n\nfunction Leak() {\n  return <p>{typeof createClient}</p>;\n}\nexport const Route = createFileRoute("/leak")({ component: Leak });\n',
    };
    const built = await buildPages(env, leaking, "app-test");
    expect({
      built: built.ok,
      errors: (built.ok ? [] : built.diagnostics)
        .filter(({ severity }) => severity === "error")
        .map(({ file, rule }) => ({ file, rule })),
    }).toStrictEqual({
      built: false,
      errors: [{ file: "src/routes/leak.tsx", rule: "imports" }],
    });
  });

  it("refuses a target it doesn't know, and an inspection of a target that has none", async () => {
    const compiler = startAppCompiler(env.LOADER, env.ASSETS, "app-test");
    // By name, as an RPC caller could send anything.
    const refusals = await Promise.all(
      [
        ["build", "everything"],
        ["buildIncrementally", "constructor"],
        ["inspect", "pages"],
        ["inspect", "toString"],
      ].map(
        async ([method = "", target]) =>
          await callStub(compiler, method, [target, typicalApp]).then(
            () => "answered",
            // What refused it, and which method says so.
            (error: unknown) =>
              error instanceof Error
                ? `${error.name}: ${error.message.split(" ")[0] ?? ""}`
                : "thrown"
          )
      )
    );
    expect(refusals).toStrictEqual([
      "TypeError: build",
      "TypeError: buildIncrementally",
      "TypeError: inspect",
      "TypeError: inspect",
    ]);
  });

  it("answers only its own methods, build, buildIncrementally, transform and inspect: never a type check, which is the checker's", async () => {
    const compiler = startAppCompiler(env.LOADER, env.ASSETS, "app-test");
    const answers = await Promise.all(
      ["check", "buildWorkflows", "checkAppCode", "buildServer"].map(
        async (method) =>
          await callStub(compiler, method, [typicalApp]).then(
            () => "answered",
            () => "refused"
          )
      )
    );
    expect(answers).toStrictEqual(["refused", "refused", "refused", "refused"]);
  });
});

/**
 * A component the React Compiler refuses (it reassigns a prop as it
 * renders), with `directive` at the top of its body.
 */
const rejected = (directive: string, name = "Probe"): string =>
  `import { useState } from "react";

export function ${name}(props: { count: number }) {
  ${directive}
  const [value] = useState(0);
  props.count = value;
  return <p>{props.count}</p>;
}
`;

/** `source` as a page of its own, `/probe`, which renders nothing. */
const routed = (source: string): string =>
  `import { createFileRoute } from "@tanstack/react-router";\n${source}export const Route = createFileRoute("/probe")({ component: () => null });\n`;

/** What building `files` beside the typical page says, by file and rule. */
const refusedIn = async (files: Record<string, string>) => {
  const built = await buildPages(env, { ...typicalApp, ...files }, "app-test");
  return built.ok
    ? "built"
    : built.diagnostics
        .filter(({ severity }) => severity === "error")
        .map(({ file, rule, message }) => ({
          file,
          rule,
          optOut: message.includes("would switch the React Compiler off"),
        }));
};

describe(
  "the React Compiler, which no App code switches off",
  { timeout: 60_000 },
  () => {
    it.each([
      [
        "a function directive in a page",
        "src/routes/probe.tsx",
        routed(rejected('"use no memo";')),
      ],
      [
        "the other function directive in a page",
        "src/routes/probe.tsx",
        routed(rejected('"use no forget";')),
      ],
      [
        "an arrow function's directive in a component",
        "src/components/probe.tsx",
        'import { useState } from "react";\n\nexport const Probe = (props: { count: number }) => {\n  "use no forget";\n  const [value] = useState(0);\n  props.count = value;\n  return <p>{props.count}</p>;\n};\n',
      ],
      [
        "a module directive in a component",
        "src/components/probe.tsx",
        `"use no memo";\n${rejected("")}`,
      ],
    ])("refuses %s", async (_case, path, source) => {
      await expect(refusedIn({ [path]: source })).resolves.toStrictEqual([
        { file: path, rule: "compile", optOut: true },
      ]);
    });

    it("builds a component that only names a directive in a string or a comment, or holds another directive", async () => {
      await expect(
        refusedIn({
          "src/components/label.tsx":
            '// Never "use no memo" here: the compiler checks every component.\nexport function Label() {\n  "use strict";\n  const text = "use no memo";\n  return <p>{text}</p>;\n}\n',
        })
      ).resolves.toBe("built");
    });
  }
);
