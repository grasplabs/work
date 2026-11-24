import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

import { transform } from "lightningcss";
import type { Declaration, SelectorComponent } from "lightningcss";

/**
 * Every icon of a control moves in its own parts when the control is
 * pointed at (apps/web/src/icon-moves.css). A move names an icon's parts
 * by their number, as Lucide draws them: when Lucide redraws an icon, a
 * number can point at nothing, or at another line. The table is read by
 * Lightning CSS, the parser Vite and Tailwind build with; an icon by
 * drawing it, as Lucide puts it on the page.
 */

/** What the table says of one icon's moves. */
export interface IconMoves {
  /** The parts its moves name, by number; 0 stands for the icon itself or all of its parts. None: it has no move. */
  parts: Set<number>;
  /** Whether a move of the icon itself makes it larger or smaller, which is no move. */
  sized: boolean;
}

const lucideClass = "lucide-";

/** The part numbers a selector's `:nth-child(n)`s name, inside `:is()` and the like too. */
const nthChildren = (components: SelectorComponent[]): number[] =>
  components.flatMap((component) => {
    if (component.type !== "pseudo-class") {
      return [];
    }
    if (component.kind === "nth-child") {
      return component.a === 0 ? [component.b] : [];
    }
    if (
      component.kind === "is" ||
      component.kind === "where" ||
      component.kind === "not"
    ) {
      return component.selectors.flatMap((each) => nthChildren(each));
    }
    return [];
  });

/** The custom properties a rule sets, by name. */
const customProperties = (declarations: Declaration[]): Set<string> =>
  new Set(
    declarations.flatMap((declaration) =>
      declaration.property === "custom" ? [declaration.value.name] : []
    )
  );

/**
 * The table's moves, by the icon's Lucide name (`trash` for `.lucide-trash`):
 * the parts each rule that sets a move names, and whether a rule of the
 * whole icon sizes it, a move or not.
 */
export const iconMovesOf = (css: string): Map<string, IconMoves> => {
  const icons = new Map<string, IconMoves>();
  transform({
    filename: "icon-moves.css",
    code: Buffer.from(css),
    visitor: {
      Rule: {
        style: (rule) => {
          const set = customProperties([
            ...rule.value.declarations.declarations,
            ...rule.value.declarations.importantDeclarations,
          ]);
          const moving = set.has("--icon-move");
          const sizing = set.has("--icon-wide") || set.has("--icon-tall");
          for (const selector of rule.value.selectors) {
            const [first, ...rest] = selector;
            const whole = rest.length === 0;
            if (
              first?.type !== "class" ||
              !first.name.startsWith(lucideClass) ||
              !(moving || (whole && sizing))
            ) {
              continue;
            }
            const icon = first.name.slice(lucideClass.length);
            const moves = icons.get(icon) ?? {
              parts: new Set<number>(),
              sized: false,
            };
            if (moving) {
              const numbers = nthChildren(rest);
              for (const number of numbers.length > 0 ? numbers : [0]) {
                moves.parts.add(number);
              }
            }
            if (whole && sizing) {
              moves.sized = true;
            }
            icons.set(icon, moves);
          }
        },
      },
    },
  });
  return icons;
};

/** An icon as it comes onto the page: the name in its class, and how many parts it is drawn in. */
export interface DrawnIcon {
  icon: string;
  parts: number;
}

const iconClass = /class="lucide lucide-(?<icon>[a-z0-9-]+)/u;
const shapes = /<(?:path|circle|rect|line|polyline|polygon|ellipse)\b/gu;

/** What `lucide-react` exports beside its icons. */
const notIcons = new Set(["icons", "createLucideIcon", "Icon"]);

/** What `module` exports as `name`. */
const propertyOf = (module: unknown, name: string): unknown =>
  typeof module === "object" && module !== null
    ? Reflect.get(module, name)
    : undefined;

/** The function `module` exports as `name`. */
const functionOf = (
  module: unknown,
  name: string
): ((...args: unknown[]) => unknown) => {
  const found: unknown = propertyOf(module, name);
  if (typeof found !== "function") {
    throw new TypeError(`No function ${name} to draw an icon with`);
  }
  return (...args) => {
    const result: unknown = Reflect.apply(found, undefined, args);
    return result;
  };
};

/** Each icon drawn, by the `lucide-react` it was drawn from and its export's name. */
const drawn = new Map<string, DrawnIcon | undefined>();

/**
 * The icon `lucide-react` exports as `name`, drawn from the copy `file`
 * resolves, or undefined for a name that isn't an icon.
 */
export const drawIcon = (file: string, name: string): DrawnIcon | undefined => {
  if (notIcons.has(name) || name.startsWith("Lucide")) {
    return undefined;
  }
  const required = createRequire(file);
  const key = `${required.resolve("lucide-react")}#${name}`;
  if (drawn.has(key)) {
    return drawn.get(key);
  }
  const lucide: unknown = required("lucide-react");
  const createElement = functionOf(required("react"), "createElement");
  const render = functionOf(
    required("react-dom/server"),
    "renderToStaticMarkup"
  );
  const component = propertyOf(lucide, name);
  const isComponent =
    typeof component === "function" ||
    (typeof component === "object" &&
      component !== null &&
      "$$typeof" in component);
  let icon: DrawnIcon | undefined;
  if (isComponent) {
    const markup = String(render(createElement(component)));
    const found = iconClass.exec(markup)?.groups?.icon;
    if (found !== undefined) {
      icon = { icon: found, parts: markup.match(shapes)?.length ?? 0 };
    }
  }
  drawn.set(key, icon);
  return icon;
};

/** Each table read, by its path, with when it was last changed. */
const tables = new Map<
  string,
  { changed: number; moves: Map<string, IconMoves> }
>();

/** The table at `path`, read again once it changes: an editor's lint sees each change. */
export const iconMovesAt = (path: string): Map<string, IconMoves> => {
  const changed = statSync(path).mtimeMs;
  const known = tables.get(path);
  if (known?.changed === changed) {
    return known.moves;
  }
  const moves = iconMovesOf(readFileSync(path, "utf-8"));
  tables.set(path, { changed, moves });
  return moves;
};
