/**
 * The design system's checks of an App's classes, in the build's Tailwind
 * step: every class a page or a component writes, read as Tailwind reads
 * it, against the kit's own theme (`Kit.colors`) and components
 * (`Kit.components`), each refusal naming what to use instead.
 *
 * - `design/no-unknown-classes`: a class Tailwind makes no CSS of.
 * - `design/no-raw-colors`: a colour of Tailwind's palette, not the theme's.
 * - `design/no-arbitrary-values`: a `[…]` value, off the theme and its scale.
 * - `design/no-restyle`: a class on one of the kit's components that sets
 *   its look (colour, type, spacing, shape, effects, motion): a component
 *   owns its look, its variants pick it, and a page only places it.
 *
 * Classes are read where the source writes them: a `className`, and what
 * a class helper (`cn`, `clsx`, `cva`, …) takes as classes. A class built
 * at run time can't be read, and the frame's CSP holds what the page does
 * with it.
 */
import { __unstable__loadDesignSystem } from "tailwindcss";

import kit from "#kit";

import type { Diagnostic } from "./diagnostic.ts";
import { kitStylesheet, ownEntry } from "./kit.ts";
import { child, children, walk } from "./syntax.ts";
import type { Node, Parsed } from "./syntax.ts";

/** Added to every refusal of a restyle: an App uses the kit as it is. */
const designNote =
  "Pages can't change the kit (@grasp-os/ui): use what it has, or build the look from plain elements.";

/** Helpers whose string arguments are class lists. */
const classHelpers = new Set([
  "cn",
  "clsx",
  "cva",
  "twMerge",
  "twJoin",
  "classNames",
]);

/** cva's keys whose string values are classes in a compound variant. */
const cvaClassKeys = new Set(["class", "className"]);

/** A string of classes in the source: its text, and where it starts. */
interface ClassText {
  text: string;
  /** The offset of the text's first unit in the file. */
  start: number;
}

/** A string literal's or a template's text, where its first unit is. */
const textOf = (node: Node): ClassText[] => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return [{ text: node.value, start: node.start + 1 }];
  }
  if (node.type === "TemplateElement") {
    // Its value is `{ raw, cooked }`, not a node.
    const { value } = node;
    const cooked: unknown =
      typeof value === "object" && value !== null
        ? Reflect.get(value, "cooked")
        : undefined;
    return typeof cooked === "string"
      ? [{ text: cooked, start: node.start }]
      : [];
  }
  return [];
};

/** A property's key as written: an identifier's name or a string's text. */
const keyName = (property: Node): string | undefined => {
  const key = child(property, "key");
  if (property.computed === true || key === undefined) {
    return undefined;
  }
  const name = key.type === "Identifier" ? key.name : key.value;
  return typeof name === "string" ? name : undefined;
};

/** A property's key as clsx reads it, a class: its text, where it starts. */
const keyText = (property: Node): ClassText[] => {
  const key = child(property, "key");
  if (property.computed === true || key === undefined) {
    return [];
  }
  if (key.type === "Literal") {
    return textOf(key);
  }
  return key.type === "Identifier" && typeof key.name === "string"
    ? [{ text: key.name, start: key.start }]
    : [];
};

/** Reads an expression's class texts (`classesIn`), as clsx reads it with `keys`. */
type Read = (node: Node | undefined, keys: boolean) => ClassText[];

/** What a helper call takes as classes: each argument, by the helper's rules. */
const helperClasses = (call: Node, read: Read): ClassText[] => {
  const callee = child(call, "callee");
  const helper = callee?.type === "Identifier" ? callee.name : undefined;
  const [first, options] = children(call, "arguments");
  if (helper !== "cva") {
    return children(call, "arguments").flatMap((each) => read(each, true));
  }
  // cva: its base, each variant's value and a compound variant's class.
  const variants = children(options, "properties").flatMap((property) => {
    const name = keyName(property);
    const value = child(property, "value");
    if (name === "variants") {
      return children(value, "properties").flatMap((group) =>
        children(child(group, "value"), "properties").flatMap((each) =>
          read(child(each, "value"), false)
        )
      );
    }
    if (name === "compoundVariants") {
      return children(value, "elements").flatMap((compound) =>
        children(compound, "properties")
          .filter((each) => cvaClassKeys.has(keyName(each) ?? ""))
          .flatMap((each) => read(child(each, "value"), false))
      );
    }
    return [];
  });
  return [...read(first, false), ...variants];
};

/** Whether `node` calls a class helper (`classHelpers`). */
const isHelperCall = (node: Node): boolean => {
  const callee = child(node, "callee");
  return (
    node.type === "CallExpression" &&
    callee?.type === "Identifier" &&
    typeof callee.name === "string" &&
    classHelpers.has(callee.name)
  );
};

/** Expressions a class text passes through unchanged. */
const wrappers = new Set([
  "JSXExpressionContainer",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
]);

/**
 * The class texts an expression can give: its strings, both sides of a
 * condition, what a class helper takes (each helper call read added to
 * `seen`); with `keys`, as clsx reads an object, its keys. Nothing it
 * can't read: a variable, any other call.
 */
const classesIn = (
  node: Node | undefined,
  seen: Set<Node>,
  keys: boolean
): ClassText[] => {
  const read: Read = (each, asKeys) => classesIn(each, seen, asKeys);
  if (node === undefined) {
    return [];
  }
  if (wrappers.has(node.type)) {
    return read(child(node, "expression"), keys);
  }
  if (isHelperCall(node)) {
    seen.add(node);
    return helperClasses(node, read);
  }
  switch (node.type) {
    case "Literal": {
      return textOf(node);
    }
    case "TemplateLiteral": {
      return [
        ...children(node, "quasis").flatMap(textOf),
        ...children(node, "expressions").flatMap((each) => read(each, keys)),
      ];
    }
    case "ConditionalExpression": {
      return [
        ...read(child(node, "consequent"), keys),
        ...read(child(node, "alternate"), keys),
      ];
    }
    // `a && "x"` gives `a` only when it's falsy: never a class.
    case "LogicalExpression": {
      return [
        ...(node.operator === "&&" ? [] : read(child(node, "left"), keys)),
        ...read(child(node, "right"), keys),
      ];
    }
    case "ArrayExpression": {
      return children(node, "elements").flatMap((each) => read(each, keys));
    }
    case "ObjectExpression": {
      return keys ? children(node, "properties").flatMap(keyText) : [];
    }
    default: {
      return [];
    }
  }
};

/** A class as written, where it is, and the kit component it is on, if any. */
export interface ClassSite {
  readonly name: string;
  readonly line: number;
  readonly column: number;
  /** The kit component it is on: its name, as the page writes it, and its module. */
  readonly component?: { readonly name: string; readonly module: string };
}

const whitespace = /\S+/gu;

/** What a JSX element is named, as written: `Button`, or `Card` of `Card.Title`. */
const elementName = (opening: Node): string | undefined => {
  let name = child(opening, "name");
  while (name?.type === "JSXMemberExpression") {
    name = child(name, "object");
  }
  return name?.type === "JSXIdentifier" && typeof name.name === "string"
    ? name.name
    : undefined;
};

/** The kit's component modules a file imports, by the local name of each import. */
const kitImports = (program: Node): Map<string, string> => {
  const imported = new Map<string, string>();
  for (const statement of children(program, "body")) {
    const source = child(statement, "source")?.value;
    if (
      statement.type !== "ImportDeclaration" ||
      typeof source !== "string" ||
      ownEntry(kit.components, source) === undefined
    ) {
      continue;
    }
    for (const specifier of children(statement, "specifiers")) {
      const local = child(specifier, "local")?.name;
      if (typeof local === "string") {
        imported.set(local, source);
      }
    }
  }
  return imported;
};

/**
 * Every class `source` (`path`, a page or a component) writes where a
 * class goes, where it is, and the kit component it is on. None of a file
 * that doesn't parse: its compile says why.
 */
export const classSitesOf = (tree: Parsed | undefined): ClassSite[] => {
  if (tree === undefined) {
    return [];
  }
  const fromKit = kitImports(tree.program);
  const seen = new Set<Node>();
  const found: ClassSite[] = [];
  const add = (
    texts: ClassText[],
    component: ClassSite["component"] | undefined
  ): void => {
    for (const { text, start } of texts) {
      for (const match of text.matchAll(whitespace)) {
        found.push({
          name: match[0],
          ...tree.at(start + match.index),
          ...(component === undefined ? {} : { component }),
        });
      }
    }
  };
  walk(tree.program, (node) => {
    if (node.type === "JSXOpeningElement") {
      const name = elementName(node);
      const module = name === undefined ? undefined : fromKit.get(name);
      for (const attribute of children(node, "attributes")) {
        const attributeName = child(attribute, "name")?.name;
        if (attributeName === "className" || attributeName === "class") {
          add(
            classesIn(child(attribute, "value"), seen, false),
            name === undefined || module === undefined
              ? undefined
              : { name, module }
          );
        }
      }
    }
  });
  // Class helpers outside a `className`: a component's own `cva`, a
  // `cn(…)` kept in a variable.
  walk(tree.program, (node) => {
    if (isHelperCall(node) && !seen.has(node)) {
      add(classesIn(node, seen, false), undefined);
    }
  });
  return found;
};

/**
 * The look a CSS property sets, which a kit component owns: its colour,
 * spacing (padding and gaps), type, shape, effects and motion, as
 * shadcn's lint sorts properties. Anything else places it (margin, size,
 * position, display, flex and grid placement, text alignment): a page's.
 */
const looks: readonly [RegExp, string][] = [
  [
    /(?:^|-)color$|^(?:background|fill|stroke|--tw-(?:gradient-(?:from|via|to)|shadow-color|ring-color|inset-ring-color|inset-shadow-color)$|--tw-.*-color$)/u,
    "colour",
  ],
  [/^(?:padding|gap$|row-gap$|column-gap$)/u, "spacing"],
  [
    /^(?:font|letter-spacing$|line-height$|text-decoration|text-transform$|text-indent$|text-underline|word-spacing$|list-style|--tw-(?:font|leading|tracking))/u,
    "type",
  ],
  [
    /^(?:border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-(?:width|style|radius))?$|border-.*-radius$|outline|--tw-ring-width$|--tw-ring-inset$|--tw-border-style$)/u,
    "shape",
  ],
  [
    /^(?:box-shadow|text-shadow|opacity|filter|backdrop-filter|mix-blend-mode|background-blend-mode|--tw-(?:shadow|inset-shadow|drop-shadow|blur|brightness|contrast|grayscale|hue-rotate|invert|saturate|sepia|backdrop-.*)$)/u,
    "effects",
  ],
  [/^(?:transition|animation|--tw-(?:duration|ease|delay)$)/u, "motion"],
];

/** A class as Tailwind reads it against the kit's theme. */
interface Reading {
  /** Whether Tailwind makes CSS of it. */
  known: boolean;
  /** The looks it sets (`looks`), none for a layout class. */
  looks: string[];
  /** Palette colours it uses, not the theme's. */
  palette: string[];
  /** Whether its value, or its modifier, is `[…]`. */
  arbitrary: boolean;
}

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;

let designSystem: Promise<DesignSystem> | undefined;

/** Tailwind's design system of the kit's theme, loaded once per isolate. */
const kitDesignSystem = async (): Promise<DesignSystem> => {
  designSystem ??= __unstable__loadDesignSystem(
    kit.stylesheets[kitStylesheet] ?? "",
    {
      // oxlint-disable-next-line require-await -- Tailwind expects a promise
      loadStylesheet: async (id: string) => {
        const content = ownEntry(kit.stylesheets, id);
        if (content === undefined) {
          throw new Error(`The stylesheet "${id}" is not in the kit`);
        }
        return { path: id, base: "/", content };
      },
    }
  );
  return await designSystem;
};

/** Classes that mark an element for others' variants, and make no CSS. */
const markers = /^(?:group|peer)(?:\/[\w-]+)?$/u;

/** A theme colour a declaration's value reads: `var(--color-<name>…`. */
const colorVariable = /var\(--color-(?<name>[\w-]+)/gu;

const themeColors = new Set(kit.colors);

const readings = new Map<string, Reading>();

/** Every declaration under `nodes` of Tailwind's AST: its property and value. */
const declarations = (nodes: readonly unknown[]): [string, string][] =>
  nodes.flatMap((node): [string, string][] => {
    if (typeof node !== "object" || node === null) {
      return [];
    }
    const kind: unknown = Reflect.get(node, "kind");
    if (kind === "declaration") {
      const property: unknown = Reflect.get(node, "property");
      const value: unknown = Reflect.get(node, "value");
      return typeof property === "string"
        ? [[property, typeof value === "string" ? value : ""]]
        : [];
    }
    const inner: unknown = Reflect.get(node, "nodes");
    return Array.isArray(inner) ? declarations(inner) : [];
  });

/** `name` as Tailwind reads it (`Reading`), kept for the isolate's later builds. */
const readingOf = (design: DesignSystem, name: string): Reading => {
  const kept = readings.get(name);
  if (kept !== undefined) {
    return kept;
  }
  const [ast = []] = design.candidatesToAst([name]);
  const declared = declarations(ast);
  const candidates = design.parseCandidate(name);
  const reading: Reading = {
    known: declared.length > 0 || markers.test(name),
    looks: [
      ...new Set(
        declared.flatMap(([property]) =>
          looks
            .filter(([pattern]) => pattern.test(property))
            .map(([, look]) => look)
        )
      ),
    ],
    palette: [
      ...new Set(
        declared.flatMap(([, value]) =>
          [...value.matchAll(colorVariable)]
            .map((match) => match.groups?.name ?? "")
            .filter((color) => color !== "" && !themeColors.has(color))
        )
      ),
    ],
    arbitrary: candidates.some(
      (candidate) =>
        candidate.kind === "arbitrary" ||
        (candidate.kind === "functional" &&
          (candidate.value?.kind === "arbitrary" ||
            candidate.modifier?.kind === "arbitrary"))
    ),
  };
  if (readings.size > 50_000) {
    readings.clear();
  }
  readings.set(name, reading);
  return reading;
};

/** The edit distance of two strings, for the nearest known class. */
const distance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
};

/** The variants before a class's utility (`md:hover:`), and the utility. */
const variantsOf = (name: string): [string, string] => {
  let depth = 0;
  let split = 0;
  for (let index = 0; index < name.length; index += 1) {
    const char = name.charAt(index);
    if (char === "[" || char === "(") {
      depth += 1;
    } else if (char === "]" || char === ")") {
      depth -= 1;
    } else if (char === ":" && depth === 0) {
      split = index + 1;
    }
  }
  return [name.slice(0, split), name.slice(split)];
};

/** The known class nearest `name`, close enough to be a slip, if there is one. */
const nearestOf = (design: DesignSystem, name: string): string | undefined => {
  const [variants, utility] = variantsOf(name);
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(utility.length / 4)) + 1;
  for (const [known] of design.getClassList()) {
    if (Math.abs(known.length - utility.length) >= bestDistance) {
      continue;
    }
    const found = distance(utility, known);
    if (found < bestDistance) {
      best = known;
      bestDistance = found;
    }
  }
  return best === undefined ? undefined : `${variants}${best}`;
};

/**
 * How many unknown classes one build looks for the nearest known class
 * of: each look reads every class Tailwind knows (some 23,000), so past
 * these the rest are refused without a suggestion, and a page of many
 * stays within the call's CPU time.
 */
const suggestedPerBuild = 20;

/** The nearest known class of each unknown one looked for, kept for the isolate's later builds. */
const suggestions = new Map<string, string | undefined>();

/**
 * The nearest known class of `name` (`nearestOf`), kept by name; none once
 * `looked` (this build's names looked for) holds `suggestedPerBuild`.
 */
const nearest = (
  design: DesignSystem,
  name: string,
  looked: Set<string>
): string | undefined => {
  if (suggestions.has(name)) {
    return suggestions.get(name);
  }
  if (looked.size >= suggestedPerBuild) {
    return undefined;
  }
  looked.add(name);
  const found = nearestOf(design, name);
  if (suggestions.size > 50_000) {
    suggestions.clear();
  }
  suggestions.set(name, found);
  return found;
};

/** How many of the theme's colours a message lists before a count. */
const listedColors = 16;

/** The theme's colours, surfaces before the text on them, as a message lists them. */
const colorList = (): string => {
  const sorted = [...kit.colors].toSorted(
    (a, b) =>
      Number(a.endsWith("-foreground")) - Number(b.endsWith("-foreground")) ||
      a.localeCompare(b)
  );
  const shown = sorted.slice(0, listedColors);
  const rest = sorted.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (and ${rest} more)` : shown.join(", ");
};

/** A length in px or rem, as an arbitrary value may give one. */
const length = /^\[(?<amount>\d*\.?\d+)(?<unit>px|rem)\]$/u;

/** The spacing scale's step: Tailwind's `--spacing`, 0.25rem. */
const spacingPx = 4;

/** The class on the spacing scale with the same value as an arbitrary length, if any. */
const onScale = (name: string): string | undefined => {
  const [variants, utility] = variantsOf(name);
  const dash = utility.indexOf("-[");
  const found = length.exec(utility.slice(dash + 1))?.groups;
  if (dash === -1 || found === undefined) {
    return undefined;
  }
  const px = Number(found.amount) * (found.unit === "rem" ? 16 : 1);
  const steps = px / spacingPx;
  return Number.isInteger(steps * 2)
    ? `${variants}${utility.slice(0, dash)}-${steps}`
    : undefined;
};

/** A kit module's variant props, as a message offers them. */
const variantsText = (module: string): string => {
  const groups = Object.entries(ownEntry(kit.components, module) ?? {});
  return groups.length === 0
    ? "It has no variants: use it as it is, or build the look from plain elements around it."
    : `Pick one of its variants instead: ${groups
        .map(([prop, values]) => `${prop} (${values.join(", ")})`)
        .join("; ")}.`;
};

/** What `site` breaks, as `reading` reads its class. */
const problemsOf = (
  file: string,
  site: ClassSite,
  reading: Reading,
  design: DesignSystem,
  looked: Set<string>
): Diagnostic[] => {
  const at = { file, line: site.line, column: site.column };
  const error = (rule: string, message: string, fix?: string): Diagnostic => ({
    ...at,
    rule,
    severity: "error",
    message,
    ...(fix === undefined ? {} : { fix }),
  });
  const { name } = site;
  if (!reading.known) {
    const suggestion = nearest(design, name, looked);
    return [
      suggestion === undefined
        ? error(
            "design/no-unknown-classes",
            `"${name}" is not a class the kit's Tailwind knows, so no CSS is generated for it. Fix the spelling, or use a class Tailwind generates from the kit's theme.`
          )
        : error(
            "design/no-unknown-classes",
            `"${name}" is not a class the kit's Tailwind knows, so no CSS is generated for it. Did you mean "${suggestion}"?`,
            `Replace with "${suggestion}".`
          ),
    ];
  }
  const found: Diagnostic[] = [];
  if (reading.arbitrary) {
    const scaled = onScale(name);
    found.push(
      scaled === undefined
        ? error(
            "design/no-arbitrary-values",
            `"${name}" hardcodes a value off the kit's theme. Use a theme token or a value on its scale (a spacing step, a size, a theme colour) instead.`
          )
        : error(
            "design/no-arbitrary-values",
            `"${name}" hardcodes a value off the kit's theme. Use "${scaled}" instead (the same value, on the scale).`,
            `Replace with "${scaled}".`
          )
    );
  }
  if (reading.palette.length > 0) {
    found.push(
      error(
        "design/no-raw-colors",
        `"${name}" uses Tailwind's palette (${reading.palette.join(", ")}), not the kit's theme. Use one of the theme's colours: ${colorList()}.`
      )
    );
  }
  if (site.component !== undefined && reading.looks.length > 0) {
    const { name: component, module } = site.component;
    found.push(
      error(
        "design/no-restyle",
        `"${name}" is not allowed on <${component}>: <${component}> owns its ${reading.looks.join(" and ")}. ${variantsText(module)} Only layout goes on a kit component (margin, size, position, flex and grid placement); put the rest on an element around it. ${designNote}`
      )
    );
  }
  return found;
};

/**
 * What the classes `sites` holds (one file's, `file`) break, each where
 * it is: read by Tailwind against the kit's theme, once per class.
 * `looked` is the unknown classes this build looked for the nearest known
 * class of (`suggestedPerBuild`), one set for all its files.
 */
export const classProblems = async (
  file: string,
  sites: readonly ClassSite[],
  looked: Set<string>
): Promise<Diagnostic[]> => {
  if (sites.length === 0) {
    return [];
  }
  const design = await kitDesignSystem();
  return sites.flatMap((site) =>
    problemsOf(file, site, readingOf(design, site.name), design, looked)
  );
};
