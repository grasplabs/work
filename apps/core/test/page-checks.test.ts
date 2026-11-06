import {
  startAppCompiler,
  startTypeChecker,
  startUltracite,
} from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import { generatedPaths, symbolicModules } from "@grasp-os/sdk/host";
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

/** What the design system's rules are named by: @shadcn/lint's and Grasp's own. */
const designRule = /^(?:shadcn|grasp)\//u;

/**
 * What the design system's lint finds in `files`, in the lint's isolate
 * (Ultracite's `lint`), with `beside` on disk, and whether it passes.
 */
const designLint = async (
  files: Record<string, string>,
  beside?: Record<string, string>
): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> => {
  const linted = await startUltracite(env.LOADER, env.ASSETS).lint(
    files,
    beside
  );
  const diagnostics = Object.keys(linted)
    .toSorted()
    .flatMap((path) => linted[path] ?? [])
    .filter(({ rule }) => designRule.test(rule));
  return {
    ok: diagnostics.every(({ severity }) => severity !== "error"),
    diagnostics,
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
        /^src\/routes\/index\.tsx:26:40 compile error: Unexpected token/u
      ),
    ]);
    expect(built.diagnostics[0]?.rule).toBe("compile");
  });

  it("fails a compile error and a type error in one build, none hiding another, and leaves a restyle to the lint", async () => {
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

// The design system's lint (packages/compiler/src/lint.ts), part of the
// lint's isolate's: what it finds blocks a proposal, never a build or a
// preview (agent-builds.test.ts, draft-proposals.test.ts).
describe("the design system's lint", { timeout: 60_000 }, () => {
  it("passes the build and the preview of a page it fails", async () => {
    const files = app(
      withLine(
        `<Button size="sm">`,
        `<Button size="sm" className="rounded-full">`
      )
    );

    const [built, previewed, linted] = await Promise.all([
      buildPages(env, files, "app-test"),
      buildPages(env, files, "app-test", { profile: "preview" }),
      designLint(files),
    ]);

    expect({
      built: built.ok,
      previewed: previewed.ok,
      linted: linted.diagnostics.map(({ file, rule }) => `${file} ${rule}`),
    }).toStrictEqual({
      built: true,
      previewed: true,
      linted: ["src/routes/index.tsx shadcn/no-restyle"],
    });
  });

  it("names a restyle in a page that neither compiles nor type-checks", async () => {
    const linted = await designLint({
      "src/routes/when.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { useState } from "react";
import { Button } from "@grasp-os/ui/components/button";

function When() {
  const open = window.innerWidth > 0;
  if (open) {
    useState(0);
  }
  const wrong: number = "one";
  return <Button className="rounded-full">{wrong}</Button>;
}
export const Route = createFileRoute("/when")({ component: When });
`,
    });

    expect(
      linted.diagnostics.map(({ file, rule }) => `${file} ${rule}`)
    ).toStrictEqual(["src/routes/when.tsx shadcn/no-restyle"]);
  });

  it("reads a component of the App's own that wraps the kit's, from another call's files", async () => {
    const wrapper = `import { Button } from "@grasp-os/ui/components/button";
import type { ComponentProps } from "react";

export const Action = (props: ComponentProps<typeof Button>) => <Button {...props} />;
`;
    const page = `import { createFileRoute } from "@tanstack/react-router"; import { Action } from "../components/action";

function Act() {
  return <Action className="rounded-full">Go</Action>;
}
export const Route = createFileRoute("/")({ component: Act });
`;

    const linted = await designLint(
      { "src/routes/act.tsx": page },
      { "src/routes/act.tsx": page, "src/components/action.tsx": wrapper }
    );

    expect(
      linted.diagnostics.map(({ file, rule }) => `${file} ${rule}`)
    ).toStrictEqual(["src/routes/act.tsx shadcn/no-restyle"]);
  });

  it("fails a restyled component, naming its variants and sizes", async () => {
    const linted = await designLint(
      app(
        withLine(
          `<Button size="sm">`,
          `<Button size="sm" className="rounded-full px-8">`
        )
      )
    );

    expect(linted.ok).toBeFalsy();
    expect(
      linted.diagnostics.map((diagnostic) => summary(diagnostic))
    ).toStrictEqual([
      expect.stringContaining(
        'src/routes/index.tsx:44:41 shadcn/no-restyle error: "rounded-full" is not allowed on <Button>: <Button> owns its shape. Use a variant: default, outline, secondary, ghost, destructive, link, hint, ask, highlight.'
      ),
      expect.stringContaining(
        'src/routes/index.tsx:44:41 shadcn/no-restyle error: "px-8" is not allowed on <Button>: <Button> owns its spacing. Use a size (default, xs, sm, lg, xl, icon, icon-xs, icon-sm, icon-lg, inline)'
      ),
    ]);
  });

  it("knows the kit's own classes and reads disable comments as oxlint does, as an exported App's lint does", async () => {
    const linted = await designLint(app(designCases));

    expect({
      ok: linted.ok,
      found: linted.diagnostics.map(({ file, rule }) => `${file} ${rule}`),
      // Only the class Tailwind doesn't know: the theme's `ease-house`,
      // tw-animate-css's `animate-in` and `fade-in` and the kit's own
      // `type-display` are classes the kit has.
      unknown: linted.diagnostics.map(({ message }) =>
        message.slice(0, message.indexOf(" is not"))
      ),
    }).toStrictEqual({
      ok: false,
      found: designFindings,
      unknown: ['"foo-bar"'],
    });
  });

  it("fails a raw colour, naming the theme token to use", async () => {
    const linted = await designLint(
      app(
        withLine(
          `<main className="flex flex-col gap-4 p-6">`,
          `<main className="flex flex-col gap-4 bg-red-500 p-6">`
        )
      )
    );

    expect(linted.ok).toBeFalsy();
    expect(
      linted.diagnostics.map((diagnostic) => summary(diagnostic))
    ).toStrictEqual([
      expect.stringContaining(
        'src/routes/index.tsx:31:21 shadcn/no-raw-colors error: "bg-red-500" uses the raw Tailwind palette. Nearest theme tokens: '
      ),
    ]);
    // The theme's nearest red: the warmth of the brain's dots (the
    // brand's error red is further off).
    expect(linted.diagnostics[0]?.message).toContain("bg-brain-heat");
    expect(linted.diagnostics[0]?.fix).toBe('Replace with "bg-brain-heat".');
  });

  it("fails every other way a page styles itself outside the kit, or loads from outside, saying what to do", async () => {
    const linted = await designLint(
      app({
        "src/routes/escapes.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { cn } from "@grasp-os/ui/lib/utils";
import { useEffect, useRef } from "react";

function Escapes() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) {
      box.current.style.color = "red";
      box.current.style.setProperty("--x", "1");
      box.current.setAttribute("style", "color: red");
    }
    const sheet = document.createElement("style");
    document.head.append(sheet);
    document.adoptedStyleSheets = [new CSSStyleSheet()];
    const elements = { button: document.createElement("button") };
    elements.button.style.color = "red";
  }, []);
  return (
    <div ref={box}>
      <link rel="stylesheet" href="https://cdn.example/theme.css" />
      <img alt="" src="https://cdn.example/logo.png" />
      <img alt="" srcSet="data:image/png;base64,AAAA 1x,https://cdn.example/logo@2x.png 2x" />
      <img alt="" srcSet="/local.png (foo(bar),https://cdn.example/image.png 2x" />
      <div className="!p-2 gap-2" />
      <div dangerouslySetInnerHTML={{ __html: "<b>hi</b>" }} />
      <div className={cn("gap-2", [{ "p-4!": true }])} />
      <div className={\`md:!flex \${["gap", "2"].join("-")}\`} />
    </div>
  );
}
export const Route = createFileRoute("/")({ component: Escapes });
`,
      })
    );

    expect(linted.ok).toBeFalsy();
    expect(
      linted.diagnostics
        .filter(({ file }) => file === "src/routes/escapes.tsx")
        .map(({ line, rule }) => `${line} ${rule}`)
    ).toStrictEqual([
      "8 grasp/no-style-escapes",
      "9 grasp/no-style-escapes",
      "10 grasp/no-style-escapes",
      "12 grasp/no-style-escapes",
      "13 grasp/no-style-escapes",
      "14 grasp/no-style-escapes",
      "14 grasp/no-style-escapes",
      "16 grasp/no-style-escapes",
      "20 grasp/no-remote-resources",
      "21 grasp/no-remote-resources",
      "22 grasp/no-remote-resources",
      "23 grasp/no-remote-resources",
      "24 grasp/no-important",
      "25 grasp/no-style-escapes",
      "26 grasp/no-important",
      "27 grasp/no-important",
    ]);
    // Each says what to do instead.
    expect(
      linted.diagnostics.every(({ message }) =>
        /kit|lucide-react|data: or blob:/u.test(message)
      )
    ).toBeTruthy();
  });

  it("fails a page that names WebRTC or makes a nested document, saying what to do", async () => {
    const linted = await designLint(
      app({
        "src/routes/peers.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { useEffect, useRef } from "react";

function Peers() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const connection = new RTCPeerConnection();
    const legacy = window.webkitRTCPeerConnection;
    const channel: RTCDataChannel | undefined = undefined;
    const quoted = globalThis["RTCIceTransport"];
    const nested = document.createElement("iframe");
    const realm = nested.contentWindow;
    void [connection, legacy, channel, quoted, realm, box];
  }, []);
  return (
    <div ref={box}>
      <iframe title="nested" />
    </div>
  );
}
export const Route = createFileRoute("/peers")({ component: Peers });
`,
      })
    );

    expect(linted.ok).toBeFalsy();
    expect(
      linted.diagnostics
        .filter(({ rule }) => rule === "grasp/no-peer-connections")
        .map(({ line, rule }) => `${line} ${rule}`)
    ).toStrictEqual([
      "6 grasp/no-peer-connections",
      "7 grasp/no-peer-connections",
      "8 grasp/no-peer-connections",
      "9 grasp/no-peer-connections",
      "10 grasp/no-peer-connections",
      "11 grasp/no-peer-connections",
      "16 grasp/no-peer-connections",
    ]);
    // Each says what to do instead.
    expect(
      linted.diagnostics
        .filter(({ rule }) => rule === "grasp/no-peer-connections")
        .every(({ message }) => message.includes("through its App's functions"))
    ).toBeTruthy();
  });

  it("fails a plain form, which never submits in a page's frame, naming the kit's form", async () => {
    const linted = await designLint(
      app({
        "src/routes/ask.tsx": `import { createFileRoute } from "@tanstack/react-router"; function Ask() {
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <button type="submit">Ask</button>
    </form>
  );
}
export const Route = createFileRoute("/ask")({ component: Ask });
`,
      })
    );

    expect({
      ok: linted.ok,
      forms: linted.diagnostics
        .filter(({ rule }) => rule === "grasp/no-bare-forms")
        .map(({ file, line, column, fix }) => ({
          file,
          line,
          column,
          kit: fix?.includes("@grasp-os/ui/form"),
        })),
    }).toStrictEqual({
      ok: false,
      forms: [
        {
          file: "src/routes/ask.tsx",
          line: 3,
          column: 5,
          kit: true,
        },
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

  it("passes a page whose names only look like an escape", async () => {
    const linted = await designLint(
      app({
        "src/routes/lookalikes.tsx": `import { createFileRoute } from "@tanstack/react-router"; import { cn } from "@grasp-os/ui/lib/utils";

const page = { head: "Tickets", style: "compact" };

interface Layout {
  style: string;
}

const relayout = (layout: Layout) => {
  layout.style = "wide";
};

function Lookalikes() {
  const { head, style } = page;
  const list = { head: "first" };
  list.head = "second";
  const options = { style: "compact" };
  options.style = "expanded";
  const theme = { style: { density: "cosy" } } as const satisfies object;
  const copy: { style: { density: string } } = { ...theme };
  copy.style.density = "compact";
  relayout(options);
  const notice = list.head === "second";
  const saved = "Saved!";
  return (
    <section aria-label={head} title={saved}>
      <p className={cn({ "font-bold": notice && "Saved!" }, notice || "gap-2")}>{options.style}</p>
      <p className={cn({ "text-muted-foreground": style === "Wow!" })}>
        {style}! {list.head} {String(new Error("Oops!").message)}
      </p>
      <img alt="" src="./logo.png" />
      <img alt="" srcSet="data:image/png;base64,AAAA 1x, blob:x 2x" />
    </section>
  );
}
export const Route = createFileRoute("/lookalikes")({ component: Lookalikes });
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
        'import { createFileRoute } from "@tanstack/react-router"; import { createClient } from "@grasp-os/sdk/client";\n\nfunction Leak() {\n  return <p>{typeof createClient}</p>;\n}\nexport const Route = createFileRoute("/leak")({ component: Leak });\n',
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
