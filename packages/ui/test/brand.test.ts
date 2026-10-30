import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { BRAND } from "@grasp-os/ui/lib/brand";
import { describe, expect, it } from "vite-plus/test";

// Grasp's colours have one source, the brand book. Its values stand once in
// the kit's stylesheet, as `--brand-*` in `:root`, and once in
// lib/brand.ts, for what the stylesheet can't reach. The two must stay
// equal, and only the themes may read the brand's values: everything else
// reads a semantic token, so a theme can change what a colour means.

const repo = path.join(import.meta.dirname, "../../..");
const stylesheet = readFileSync(
  path.join(repo, "packages/ui/src/styles.css"),
  "utf-8"
);

const kebab = (name: string): string =>
  name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

const brandValue = /--brand-(?<name>[a-z-]+):\s*(?<value>#[0-9a-f]{3,8})\b/gu;

/** Every `--brand-<name>: #hex` the stylesheet's `:root` sets. */
const brandColors = (): Record<string, string> => {
  const start = stylesheet.indexOf(":root {");
  const root = stylesheet.slice(start, stylesheet.indexOf("\n}", start));
  const colors: Record<string, string> = {};
  for (const { groups } of root.matchAll(brandValue)) {
    colors[groups?.name ?? ""] = groups?.value ?? "";
  }
  return colors;
};

/** The source files under `dir`, by their path from the repo's root. */
const sourcesUnder = (dir: string): string[] =>
  readdirSync(path.join(repo, dir), { recursive: true, encoding: "utf-8" })
    .filter((file) => /\.(?:tsx?|css)$/u.test(file))
    .filter((file) => !file.includes("node_modules"))
    .map((file) => path.join(dir, file));

describe("the brand's colours", () => {
  it("are the same in the stylesheet and in lib/brand.ts", () => {
    expect(
      Object.fromEntries(
        Object.entries(BRAND).map(([name, value]) => [kebab(name), value])
      )
    ).toStrictEqual(brandColors());
  });

  it("are read by the themes only, never by a page or a component", () => {
    const reading = ["packages/ui/src", "apps/web/src", "apps/admin/src"]
      .flatMap(sourcesUnder)
      .filter((file) => file !== path.join("packages/ui/src/styles.css"))
      .filter((file) =>
        /var\(--brand-|--brand-[a-z]/u.test(
          readFileSync(path.join(repo, file), "utf-8")
        )
      );
    expect(reading).toStrictEqual([]);
  });
});
