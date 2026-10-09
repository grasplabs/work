import { readFileSync } from "node:fs";

import * as lucide from "lucide-react";
import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

// Every icon of a control moves in its own parts when the control is
// pointed at (icon-moves.css), so an icon the app starts using needs a move
// there. A move names an icon's parts by their number, as Lucide draws
// them: when Lucide redraws an icon, a number can point at nothing, or at
// another line. As in the prototype (`src/icon-moves.test.ts`).

// Read from the file: a stylesheet imported in a test comes back empty.
const table = readFileSync(new URL("icon-moves.css", import.meta.url), "utf-8");
const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.ts", "!./routeTree.gen.ts"],
  { query: "?raw", import: "default", eager: true }
);

const lucideImport =
  /import\s*(?:type\s*)?\{(?<list>[^}]+)\}\s*from\s*["']lucide-react["']/gu;

/** Every Lucide icon a file of the app imports, by the name it is imported under. */
const imported = (): Set<string> => {
  const names = new Set<string>();
  for (const source of Object.values(sources)) {
    for (const { groups } of source.matchAll(lucideImport)) {
      for (const each of (groups?.list ?? "").split(",")) {
        const [name = ""] = each
          .trim()
          .replace(/^type\s+/u, "")
          .split(/\s+as\s+/u);
        // What Lucide exports that is no icon (a type, its helpers) is no icon here.
        if (
          name !== "" &&
          name in lucide &&
          name !== "icons" &&
          name !== "createLucideIcon" &&
          !name.startsWith("Lucide")
        ) {
          names.add(name);
        }
      }
    }
  }
  return names;
};

const iconClass = /class="lucide lucide-(?<icon>[a-z0-9-]+)/u;
const shapes = /<(?:path|circle|rect|line|polyline|polygon|ellipse)\b/gu;

/** A React component: a function, or what `forwardRef` and `memo` make. */
const isComponent = (value: unknown): value is ComponentType =>
  typeof value === "function" ||
  (typeof value === "object" && value !== null && "$$typeof" in value);

/** An icon as it comes onto the page: the name in its class, and how many parts it is drawn in. */
const drawn = (name: string): { icon: string; parts: number } => {
  const component: unknown = Reflect.get(lucide, name);
  if (!isComponent(component)) {
    throw new Error(`lucide-react has no ${name}`);
  }
  const markup = renderToStaticMarkup(createElement(component));
  const icon = iconClass.exec(markup)?.groups?.icon;
  if (icon === undefined) {
    throw new Error(`${name} has no Lucide class`);
  }
  return { icon, parts: markup.match(shapes)?.length ?? 0 };
};

const moveRule =
  /^\.lucide-(?<icon>[a-z0-9-]+)(?<selector>[^{]*)\{(?<rules>[^}]*)\}/gmu;
const nthChild = /:nth-child\((?<part>\d+)\)/gu;

/** The parts each icon's moves name, by number; 0 stands for the icon itself or all of its parts. Only rules that set a move count. */
const moved = (): Map<string, Set<number>> => {
  const icons = new Map<string, Set<number>>();
  for (const { groups } of table.matchAll(moveRule)) {
    // A rule that sets no move (`overflow: visible`, say) is none.
    if (!(groups?.rules ?? "").includes("--icon-move:")) {
      continue;
    }
    const icon = groups?.icon ?? "";
    const parts = icons.get(icon) ?? new Set<number>();
    const numbers = [...(groups?.selector ?? "").matchAll(nthChild)].map(
      (match) => Number(match.groups?.part)
    );
    for (const number of numbers.length > 0 ? numbers : [0]) {
      parts.add(number);
    }
    icons.set(icon, parts);
  }
  return icons;
};

const wholeIcon = /^\.lucide-[a-z0-9-]+ \{(?<rules>[^}]*)\}/gmu;

describe("every icon has a move of its own", () => {
  const moves = moved();
  const icons = [...imported()].map((name) => ({ name, ...drawn(name) }));

  it("finds the icons and the table", () => {
    expect([icons.length > 50, moves.size > 100]).toStrictEqual([true, true]);
  });

  it("has a move for every Lucide icon the app uses", () => {
    const without = icons
      .filter(({ icon }) => !moves.has(icon))
      .map(({ name, icon }) => `${name} (.lucide-${icon})`)
      .toSorted();
    // Give each of these a move in icon-moves.css: which of its parts moves, and how.
    expect(without).toStrictEqual([]);
  });

  it("names only parts an icon has", () => {
    const beyond = icons.flatMap(({ icon, parts }) =>
      [...(moves.get(icon) ?? [])]
        .filter((part) => part > parts)
        .map(
          (part) =>
            `.lucide-${icon} has ${parts} parts, its move names part ${part}`
        )
    );
    expect(beyond).toStrictEqual([]);
  });

  it("never makes a whole icon larger and smaller", () => {
    // A move of the icon itself may turn, swing or go somewhere; its size is not a move.
    const sized = [...table.matchAll(wholeIcon)]
      .filter(({ groups }) => /--icon-(?:wide|tall)/u.test(groups?.rules ?? ""))
      .map(([rule]) => rule);
    expect(sized).toStrictEqual([]);
  });
});
