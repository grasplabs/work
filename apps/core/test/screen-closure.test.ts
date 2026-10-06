import { kitModuleName } from "@grasp-os/compiler";
import type { ScreenBundle } from "@grasp-os/shared/screens";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// What a page is sent to run one screen, measured on the bytes it gets:
// the screen's own modules and the kit's modules it imports, built by the
// real compiler from the real kit. Not the App's other screens, not the
// rest of the kit, and never the compiler or what it checks with.

const idp = mockIdp();

/**
 * The most a screen's entry may weigh, gzipped: what it loads before it
 * renders.
 */
const entryBudget = 1024 * 1024;

const files = {
  "app/server.ts": `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {}
`,
  "screens/small.tsx": `import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import { useState } from "react";

export default function Small() {
  const [count, setCount] = useState(0);
  return (
    <Card>
      <CardContent>
        <Button onClick={() => setCount(count + 1)}>Clicked {count}</Button>
      </CardContent>
    </Card>
  );
}
`,
  "screens/heavy.tsx": `import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@grasp-os/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@grasp-os/ui/components/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@grasp-os/ui/components/select";
import { Sidebar, SidebarContent, SidebarProvider } from "@grasp-os/ui/components/sidebar";

export default function Heavy() {
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
`,
};

/** Everything the page loads for a screen: its modules, the kit's, its CSS. */
const loaded = ({ modules, kit, css }: ScreenBundle): string =>
  [...Object.values(kit), ...Object.values(modules), css].join("\n");

/** A text's size in bytes once gzipped, as a browser is sent it. */
const gzipSize = async (text: string): Promise<number> => {
  const zipped = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = await new Response(zipped).arrayBuffer();
  return bytes.byteLength;
};

const kitNames = (bundle: ScreenBundle, names: string[]): boolean[] =>
  names.map((name) => Object.hasOwn(bundle.kit, kitModuleName(name)));

/** Components a small screen has no use for. */
const specialist = [
  "@grasp-os/ui/components/dialog",
  "@grasp-os/ui/components/dropdown-menu",
  "@grasp-os/ui/components/select",
  "@grasp-os/ui/components/sidebar",
];

/** The App's two screens, as a page is sent each. */
const opened = async (): Promise<{
  small: ScreenBundle;
  heavy: ScreenBundle;
}> => {
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Closure" });
  await release(builder, app, files);
  return {
    small: await builder.api.screens.open(app, "small"),
    heavy: await builder.api.screens.open(app, "heavy"),
  };
};

describe("what a screen loads", { timeout: 60_000 }, () => {
  it("is what the screen imports: not the App's other screens, not the rest of the kit", async () => {
    const { small, heavy } = await opened();
    // What both load: React, React DOM and the runtime among it.
    const both = Object.keys(small.kit).filter((name) =>
      Object.hasOwn(heavy.kit, name)
    );

    expect({
      small: {
        modules: Object.keys(small.modules),
        specialist: kitNames(small, specialist),
      },
      heavy: {
        modules: Object.keys(heavy.modules),
        specialist: kitNames(heavy, specialist),
      },
      // Never a module named but not sent.
      empty: [small, heavy]
        .flatMap(({ kit }) => Object.values(kit))
        .filter((code) => code === ""),
      // The kit's own for both, the same code under the same names: one
      // of each on a page whatever the screen, none built into the App's.
      different: both.filter((name) => heavy.kit[name] !== small.kit[name]),
    }).toStrictEqual({
      small: {
        modules: [small.entry],
        specialist: specialist.map(() => false),
      },
      heavy: {
        modules: [heavy.entry],
        specialist: specialist.map(() => true),
      },
      empty: [],
      different: [],
    });
    expect(both).toStrictEqual(
      expect.arrayContaining([
        small.runtime,
        kitModuleName("react/jsx-runtime"),
        kitModuleName("react/compiler-runtime"),
      ])
    );
  });

  it("keeps a screen within the entry budget, the compiler and its checks never in it", async () => {
    const { small, heavy } = await opened();

    const smallSize = await gzipSize(loaded(small));
    const heavySize = await gzipSize(loaded(heavy));
    expect(smallSize).toBeLessThan(entryBudget);
    // The heavy screen pays for what it imports; the small one doesn't.
    expect(heavySize).toBeGreaterThan(smallSize);
    expect(heavySize).toBeLessThan(entryBudget);
  });
});
