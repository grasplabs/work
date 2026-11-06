import { describe, expect, it } from "vite-plus/test";

import { oxcWasmModule } from "../oxc-wasm/wasm.ts";
import { startOxc } from "./oxc.ts";
import { pageRefusals } from "./refusals.ts";
import { routeTree } from "./route-tree.ts";

// The pages' syntax is oxc's, on oxc.wasm, as the compiler's isolate
// starts it.
startOxc(await oxcWasmModule());

const root = `import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({ component: Outlet });
`;

const route = (path: string, extra = ""): string =>
  `import { createFileRoute } from "@tanstack/react-router";

${extra}
export const Route = createFileRoute("${path}")({ component: Page });

function Page() {
  return null;
}
`;

/** A sidebar surface named `title`. */
const sidebar = (title: string): string =>
  `export const surface = { kind: "sidebar", title: "${title}" };\n`;

describe("an App's route tree", () => {
  it("routes each page at the address its file names, whatever shape the file takes", async () => {
    const tree = await routeTree({
      "src/routes/__root.tsx": root,
      "src/routes/index.tsx": route("/", sidebar("Home")),
      "src/routes/tasks.tsx": route("/tasks"),
      "src/routes/tasks.index.tsx": route("/tasks/", sidebar("Tasks")),
      "src/routes/tasks_.new.tsx": route("/tasks_/new", sidebar("New task")),
      "src/routes/tasks.$taskId.tsx": route("/tasks/$taskId"),
      "src/routes/_layout.tsx": route("/_layout"),
      "src/routes/_layout.inbox.tsx": route("/_layout/inbox", sidebar("Inbox")),
      "src/routes/(admin)/settings.tsx": route(
        "/(admin)/settings",
        'export const surface = { kind: "settings", title: "Settings" };\n'
      ),
      "src/components/card.tsx": "export const Card = () => null;\n",
    });
    expect({
      diagnostics: tree.diagnostics,
      generated: tree.source !== undefined,
      surfaces: tree.surfaces.map(({ path, title }) => [path, title]),
    }).toStrictEqual({
      diagnostics: [],
      generated: true,
      // Addresses as a link names them: no pathless layout, group,
      // un-nesting underscore or index slash of the route's ID.
      surfaces: [
        ["/", "Home"],
        ["/inbox", "Inbox"],
        ["/settings", "Settings"],
        ["/tasks", "Tasks"],
        ["/tasks/new", "New task"],
      ],
    });
  });

  it.each([
    [
      "a layout route around other pages",
      "src/routes/tasks/route.tsx",
      "/tasks",
    ],
    ["a pathless layout", "src/routes/_layout.tsx", "/_layout"],
  ])("refuses a surface on %s", async (_case, file, path) => {
    const tree = await routeTree({
      "src/routes/__root.tsx": root,
      "src/routes/tasks.index.tsx": route("/tasks/"),
      "src/routes/_layout.inbox.tsx": route("/_layout/inbox"),
      [file]: route(
        path,
        'export const surface = { kind: "panel", title: "Around" };\n'
      ),
    });
    expect({
      surfaces: tree.surfaces,
      refused: tree.diagnostics.map((each) => [each.rule, each.file]),
    }).toStrictEqual({ surfaces: [], refused: [["surfaces", file]] });
  });

  it("builds a page as the generator corrects it: its route's path as its file names it", async () => {
    const tree = await routeTree({
      "src/routes/__root.tsx": root,
      "src/routes/index.tsx": route("/"),
      "src/routes/about.tsx": route("/wrong"),
    });
    expect({
      diagnostics: tree.diagnostics,
      about: tree.routes["src/routes/about.tsx"]?.includes(
        'createFileRoute("/about")'
      ),
      index: tree.routes["src/routes/index.tsx"],
    }).toStrictEqual({
      diagnostics: [],
      about: true,
      index: route("/"),
    });
  });

  it("is refused a virtual route config among the pages", () => {
    expect(
      pageRefusals({
        "src/routes/index.tsx": route("/"),
        "src/routes/admin/__virtual.ts": "export default {};\n",
      }).map((each) => [each.rule, each.file])
    ).toStrictEqual([["pages", "src/routes/admin/__virtual.ts"]]);
  });

  it("lists the surfaces its pages export, by their routes", async () => {
    const tree = await routeTree({
      "src/routes/__root.tsx": root,
      "src/routes/index.tsx": route(
        "/",
        'export const surface = { kind: "sidebar", title: "All notes" } as const;\n'
      ),
      "src/routes/settings.tsx": route(
        "/settings",
        'export const surface = { kind: "settings", title: " Preferences " };\n'
      ),
    });
    expect(tree.surfaces).toStrictEqual([
      { path: "/", kind: "sidebar", title: "All notes" },
      { path: "/settings", kind: "settings", title: "Preferences" },
    ]);
  });

  it("refuses a surface it can't read without running the code", async () => {
    const tree = await routeTree({
      "src/routes/__root.tsx": root,
      "src/routes/index.tsx": route(
        "/",
        'const kind = "sidebar";\nexport const surface = { kind, title: "Notes" };\n'
      ),
    });
    expect(tree).toMatchObject({
      diagnostics: [{ rule: "surfaces", file: "src/routes/index.tsx" }],
    });
  });

  it("refuses a surface on a route with parameters", async () => {
    const tree = await routeTree({
      "src/routes/__root.tsx": root,
      "src/routes/notes.$id.tsx": route(
        "/notes/$id",
        'export const surface = { kind: "panel", title: "Note" };\n'
      ),
    });
    expect(tree).toMatchObject({
      diagnostics: [{ rule: "surfaces", file: "src/routes/notes.$id.tsx" }],
    });
  });

  it("refuses a page that exports no route, which TanStack would pass over", async () => {
    const tree = await routeTree({
      "src/routes/__root.tsx": root,
      "src/routes/index.tsx": "export default () => null;\n",
      "src/routes/-helpers/format.ts": "export const format = String;\n",
    });
    expect(tree).toMatchObject({
      diagnostics: [{ rule: "routes", file: "src/routes/index.tsx" }],
    });
  });

  it("leaves a page that doesn't parse to its compile, routing the others", async () => {
    const tree = await routeTree({
      "src/routes/__root.tsx": root,
      "src/routes/index.tsx": route("/"),
      "src/routes/broken.tsx": "export const Route = (",
    });
    expect({
      diagnostics: tree.diagnostics,
      routed: tree.source?.includes("./routes/index"),
    }).toStrictEqual({ diagnostics: [], routed: true });
  });

  it("says why the generator refuses a route", async () => {
    const tree = await routeTree({
      "src/routes/__root.tsx": root,
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

const path = "/";
export const Route = createFileRoute(path)({});
`,
    });
    expect(tree.source).toBeUndefined();
    expect(tree.diagnostics[0]?.message ?? "").not.toContain("routes-");
  });
});
