import { kitModuleName } from "@grasp-os/compiler";
import { describe, expect, it } from "vite-plus/test";

import { testApp, withFiles } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  appModulesOf,
  kitModulesOf,
  loadFrame,
  modulePartsOf,
} from "./page-frames.ts";
import type { LoadedFrame } from "./page-frames.ts";
import { signedInApi } from "./sign-in.ts";

// What a frame loads to run an App's pages, measured on the bytes it
// gets: the route tree, the pages it routes and the kit's modules they
// import, built by the real compiler from the real kit. Not the rest of
// the kit, and never the compiler or what it checks with.

const idp = mockIdp();

/**
 * The most a page's entry may weigh, gzipped: what it loads before it
 * renders.
 */
const entryBudget = 1024 * 1024;

const files = testApp(
  { name: "Closure", tables: {} },
  {
    // An App of spec 8's layout with nothing to call: what is measured is
    // the pages, which call nothing of it.
    "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import { useState } from "react";

function Small() {
  const [count, setCount] = useState(0);
  return (
    <Card>
      <CardContent>
        <Button onClick={() => setCount(count + 1)}>Clicked {count}</Button>
      </CardContent>
    </Card>
  );
}
export const Route = createFileRoute("/")({ component: Small });
`,
    "src/routes/heavy.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@grasp-os/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@grasp-os/ui/components/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@grasp-os/ui/components/select";
import { Sidebar, SidebarContent, SidebarProvider } from "@grasp-os/ui/components/sidebar";

function Heavy() {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <Select>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one">One</SelectItem>
            </SelectContent>
          </Select>
        </SidebarContent>
      </Sidebar>
      <DropdownMenu>
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Details</DialogTitle>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
export const Route = createFileRoute("/heavy")({ component: Heavy });
`,
  }
);

/** Everything a frame loads for a page: its modules, the kit's, its CSS. */
const loaded = ({ modules, page }: LoadedFrame): string =>
  [...Object.values(modules), page.css].join("\n");

/** A text's size in bytes once gzipped, as a browser is sent it. */
const gzipSize = async (text: string): Promise<number> => {
  const zipped = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = await new Response(zipped).arrayBuffer();
  return bytes.byteLength;
};

const kitNames = (frame: LoadedFrame, names: string[]): boolean[] =>
  names.map((name) => Object.hasOwn(kitModulesOf(frame), kitModuleName(name)));

/** Components a small screen has no use for. */
const specialist = [
  "@grasp-os/ui/components/dialog",
  "@grasp-os/ui/components/dropdown-menu",
  "@grasp-os/ui/components/select",
  "@grasp-os/ui/components/sidebar",
];

/** One of the App's pages, as its frame loads it. */
const framed = async (
  open: Promise<{ artifact: string; frameToken: string }>
): Promise<LoadedFrame> => {
  const frame = await loadFrame(await open);
  if (frame === null) {
    throw new Error("An opened page has a frame");
  }
  return frame;
};

/**
 * Two Apps, as a frame loads each: one of the small page alone, and one
 * with the heavy page beside it.
 */
const opened = async (): Promise<{
  small: LoadedFrame;
  heavy: LoadedFrame;
}> => {
  const builder = await signedInApi(idp, "builder");
  const { id: small } = await builder.api.apps.create({ name: "Small" });
  const { id: heavy } = await builder.api.apps.create({ name: "Heavy" });
  const smallFiles = withFiles(files, { "src/routes/heavy.tsx": null });
  await release(builder, small, smallFiles);
  await release(builder, heavy, files);
  return {
    small: await framed(builder.api.pages.open(small)),
    heavy: await framed(builder.api.pages.open(heavy)),
  };
};

describe("what an App's pages load", { timeout: 60_000 }, () => {
  it("is what its pages import: not the rest of the kit", async () => {
    const { small, heavy } = await opened();
    // What both load: React, React DOM and the runtime among it.
    const smallKit = kitModulesOf(small);
    const heavyKit = kitModulesOf(heavy);
    const both = Object.keys(smallKit).filter((name) =>
      Object.hasOwn(heavyKit, name)
    );

    expect({
      small: {
        modules: appModulesOf(small),
        specialist: kitNames(small, specialist),
      },
      heavy: {
        modules: appModulesOf(heavy),
        specialist: kitNames(heavy, specialist),
      },
      // Never a module named but not sent.
      empty: [small, heavy]
        .flatMap(({ modules }) => Object.values(modules))
        .filter((code) => code === ""),
      // The kit's own for both, the same code under the same names: one
      // of each on a page whatever the page, none built into the App's.
      different: both.filter((name) => heavyKit[name] !== smallKit[name]),
      // At the same content address, each in its own set's directory:
      // a frame's policy names its set's alone (page-frame.ts).
      moved: both.filter(
        (name) =>
          modulePartsOf(heavy.addresses[name] ?? "").hash !==
          modulePartsOf(small.addresses[name] ?? "").hash
      ),
      shared: both.some(
        (name) =>
          modulePartsOf(heavy.addresses[name] ?? "").scope ===
          modulePartsOf(small.addresses[name] ?? "").scope
      ),
    }).toStrictEqual({
      small: {
        modules: [
          "app~src~routeTree.gen.js",
          "app~src~routes~__root.js",
          "app~src~routes~index.js",
        ],
        specialist: specialist.map(() => false),
      },
      heavy: {
        modules: [
          "app~src~routeTree.gen.js",
          "app~src~routes~__root.js",
          "app~src~routes~heavy.js",
          "app~src~routes~index.js",
        ],
        specialist: specialist.map(() => true),
      },
      empty: [],
      different: [],
      moved: [],
      shared: false,
    });
    expect(both).toStrictEqual(
      expect.arrayContaining([
        small.page.runtime,
        kitModuleName("react/jsx-runtime"),
        kitModuleName("react/compiler-runtime"),
      ])
    );
  });

  it("keeps a page within the entry budget, the compiler and its checks never in it", async () => {
    const { small, heavy } = await opened();

    const smallSize = await gzipSize(loaded(small));
    const heavySize = await gzipSize(loaded(heavy));
    expect(smallSize).toBeLessThan(entryBudget);
    // The App with the heavy page pays for what it imports; the small one doesn't.
    expect(heavySize).toBeGreaterThan(smallSize);
    expect(heavySize).toBeLessThan(entryBudget);
  });
});
