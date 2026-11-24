/**
 * Whether a `style` value is Damsko's layout seam (grasp/no-inline-styles,
 * grasp-plugin.ts): StyleX styles, which a component's `LayoutStyle` prop
 * takes, never an inline style. The linter reads no types, so the value
 * is held to what can only be such a style, read from the file itself,
 * each name followed to what it is bound to (an import is the import's,
 * whatever it is called; a local that shadows one is not):
 *
 * - a member of an object made by StyleX's `create` (`create` or a
 *   namespace's `.create`, imported from `@stylexjs/stylex`) in a `const`
 *   (`layout.wide`, `layout[size]`, `layout?.wide`);
 * - a member of an object a named import brings, by a relative path, from
 *   a styles module of the app: a file of `apps/<app>/` named `styles.ts`,
 *   `*.styles.ts` or `*-styles.ts` (`import { shared } from
 *   "./page-styles.ts"`, then `shared.wide`). The rule holds that file in
 *   turn (`stylesModuleExports`): its every export is a `const` made by
 *   StyleX's `create` or holding StyleX styles as below. So without types,
 *   the importer can trust the name, as the module is checked in its own
 *   file, by the same rule;
 * - a parameter, or a property of one, whose declared type is Damsko's
 *   `LayoutStyle` (imported from `@grasp-os/ui/…`), there or in an
 *   interface or type alias it names, and never assigned;
 * - anything `satisfies LayoutStyle`, which the type checker then holds
 *   (unlike `as`, which it does not);
 * - a `const` that holds one of these;
 * - an array of these, `cond && style`, `a ?? b`, `cond ? a : b`, a `!`,
 *   `as const`, and `undefined`, `null` or `false` among them.
 *
 * Anything else, an object literal above all, is not. Such styles go only
 * to a component that takes them (`takesStylex`): Damsko's, the feature's
 * own (by a relative path, from a module that declares it as a function or
 * a class, or passes it on from Damsko) or one the file declares, and a
 * member of such a component (`Menu.Item`) only where its module assigns
 * it one of these; never a module that can't be found, an element of the
 * page, a component of another package (the kit's, the router's `Link`,
 * also when a relative module passes it on, by name, as a namespace's
 * member or destructured) or a name holding an element's.
 */
import { readFileSync, statSync } from "node:fs";
import nodePath from "node:path";

import { parseSync } from "oxc-parser";

export interface StyleNode {
  type: string;
  name?: StyleNode | string;
  value?: unknown;
  object?: StyleNode;
  property?: StyleNode;
  computed?: boolean;
  callee?: StyleNode;
  init?: StyleNode | null;
  id?: StyleNode | null;
  key?: StyleNode;
  left?: StyleNode;
  right?: StyleNode;
  operator?: string;
  consequent?: StyleNode;
  alternate?: StyleNode;
  elements?: (StyleNode | null)[];
  properties?: StyleNode[];
  arguments?: StyleNode[];
  typeAnnotation?: StyleNode | null;
  typeName?: StyleNode;
  typeArguments?: StyleNode | null;
  types?: StyleNode[];
  members?: StyleNode[];
  body?: StyleNode | StyleNode[];
  declaration?: StyleNode | null;
  kind?: string;
  expression?: StyleNode;
  source?: StyleNode | null;
  imported?: StyleNode;
  importKind?: string;
  exportKind?: string;
  specifiers?: StyleNode[];
  local?: StyleNode;
  exported?: StyleNode | null;
  declarations?: StyleNode[];
  parent?: StyleNode;
}

interface Variable {
  defs: {
    type: string;
    name: StyleNode;
    node: StyleNode;
    parent?: StyleNode | null;
  }[];
  references: { isWrite: () => boolean; init?: boolean | null }[];
}

interface Scope {
  set: Map<string, Variable>;
  upper: Scope | null;
}

export interface StyleContext {
  filename: string;
  sourceCode: { ast: StyleNode; getScope: (node: StyleNode) => Scope };
}

/** Where StyleX and Damsko are imported from. */
const stylexModule = "@stylexjs/stylex";
const damskoModule = "@grasp-os/ui/";

/**
 * A styles module of an app: a file of `apps/<app>/` named `styles.ts`,
 * `*.styles.ts` or `*-styles.ts`. Not Damsko's own (`packages/ui`), which a
 * page imports by the package's name and which is not held to this.
 */
const appStylesModule =
  /[/\\]apps[/\\][^/\\]+[/\\](?:[^/\\]+[/\\])*(?:[^/\\]*[.-])?styles\.ts$/u;

/** Whether a file is a styles module of an app, which the rule holds to its exports. */
export const isStylesModule = (filename: string): boolean =>
  appStylesModule.test(filename);

const variableOf = (
  context: StyleContext,
  node: StyleNode
): Variable | undefined => {
  if (typeof node.name !== "string") {
    return undefined;
  }
  for (
    let scope: Scope | null = context.sourceCode.getScope(node);
    scope !== null;
    scope = scope.upper
  ) {
    const found = scope.set.get(node.name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

const identifierName = (node: StyleNode | undefined): string | undefined =>
  node?.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;

/** What a name is bound to by an import: its module, the name it imports (`*` for a namespace), and whether only as a type. */
interface Import {
  readonly source: string;
  readonly imported: string;
  readonly typeOnly: boolean;
}

/** The name an import specifier imports: `*` for a namespace, `default`, or its name. */
const importedName = (specifier: StyleNode): string => {
  if (specifier.type === "ImportNamespaceSpecifier") {
    return "*";
  }
  if (specifier.type !== "ImportSpecifier") {
    return "default";
  }
  return String(
    identifierName(specifier.imported) ?? specifier.imported?.value
  );
};

const importOf = (
  context: StyleContext,
  node: StyleNode | undefined
): Import | undefined => {
  const variable =
    node?.type === "Identifier" ? variableOf(context, node) : undefined;
  const [definition] = variable?.defs ?? [];
  const specifier = definition?.node;
  const declaration = definition?.parent ?? undefined;
  const source = declaration?.source?.value;
  if (
    variable?.defs.length !== 1 ||
    definition?.type !== "ImportBinding" ||
    specifier === undefined ||
    typeof source !== "string"
  ) {
    return undefined;
  }
  return {
    source,
    imported: importedName(specifier),
    typeOnly:
      declaration?.importKind === "type" || specifier.importKind === "type",
  };
};

/** Whether anything assigns to it after it is declared. */
const isWritten = (variable: Variable): boolean =>
  variable.references.some(
    (reference) => reference.isWrite() && reference.init !== true
  );

/** The one interface or type alias a type's name is bound to, in the file. */
const typeDeclaration = (
  context: StyleContext,
  name: StyleNode | undefined
): StyleNode | undefined => {
  const variable =
    name?.type === "Identifier" ? variableOf(context, name) : undefined;
  const [definition] = variable?.defs ?? [];
  const declaration = definition?.node;
  return variable?.defs.length === 1 &&
    (declaration?.type === "TSInterfaceDeclaration" ||
      declaration?.type === "TSTypeAliasDeclaration")
    ? declaration
    : undefined;
};

/** Whether a type is Damsko's `LayoutStyle`, maybe with `undefined` or `null`. */
const isLayoutStyleType = (
  type: StyleNode | undefined,
  context: StyleContext
): boolean => {
  if (type?.type === "TSTypeReference") {
    const bound = importOf(context, type.typeName);
    return (
      bound !== undefined &&
      bound.source.startsWith(damskoModule) &&
      bound.imported === "LayoutStyle" &&
      (type.typeArguments ?? undefined) === undefined
    );
  }
  if (type?.type === "TSUnionType") {
    const types = type.types ?? [];
    return (
      types.some((member) => isLayoutStyleType(member, context)) &&
      types.every(
        (member) =>
          member.type === "TSUndefinedKeyword" ||
          member.type === "TSNullKeyword" ||
          isLayoutStyleType(member, context)
      )
    );
  }
  return false;
};

/** The declared type of `key` among a type literal's or an interface's own members. */
const ownMemberType = (type: StyleNode, key: string): StyleNode | undefined => {
  let members = type.members ?? [];
  if (type.type === "TSInterfaceBody") {
    members = Array.isArray(type.body) ? type.body : [];
  }
  const member = members.find(
    (candidate) =>
      candidate.type === "TSPropertySignature" &&
      candidate.computed !== true &&
      (identifierName(candidate.key) ?? candidate.key?.value) === key
  );
  return member?.typeAnnotation?.typeAnnotation ?? undefined;
};

/** The declared type of `key` in an object type, followed through the file's own declarations. */
const memberType = (
  type: StyleNode | undefined,
  key: string,
  context: StyleContext,
  seen: Set<StyleNode>
): StyleNode | undefined => {
  if (type === undefined || seen.has(type)) {
    return undefined;
  }
  seen.add(type);
  switch (type.type) {
    case "TSTypeLiteral":
    case "TSInterfaceBody": {
      return ownMemberType(type, key);
    }
    case "TSIntersectionType": {
      for (const part of type.types ?? []) {
        const found = memberType(part, key, context, seen);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }
    case "TSTypeReference": {
      const declaration =
        (type.typeArguments ?? undefined) === undefined
          ? typeDeclaration(context, type.typeName)
          : undefined;
      if (declaration?.type === "TSInterfaceDeclaration") {
        return memberType(
          Array.isArray(declaration.body) ? undefined : declaration.body,
          key,
          context,
          seen
        );
      }
      return memberType(
        declaration?.typeAnnotation ?? undefined,
        key,
        context,
        seen
      );
    }
    default: {
      return undefined;
    }
  }
};

/**
 * The declared type of a parameter's binding: `style: LayoutStyle`, or
 * `style` of `{ style }: Props`, a default beside it or not.
 */
const parameterType = (
  variable: Variable,
  context: StyleContext
): StyleNode | undefined => {
  const [definition] = variable.defs;
  if (
    variable.defs.length !== 1 ||
    definition?.type !== "Parameter" ||
    isWritten(variable)
  ) {
    return undefined;
  }
  let binding: StyleNode = definition.name;
  const annotation = binding.typeAnnotation ?? undefined;
  if (annotation !== undefined) {
    return annotation.typeAnnotation ?? undefined;
  }
  if (binding.parent?.type === "AssignmentPattern") {
    binding = binding.parent;
  }
  const property = binding.parent;
  const pattern = property?.parent;
  if (
    property?.type !== "Property" ||
    property.computed === true ||
    pattern?.type !== "ObjectPattern"
  ) {
    return undefined;
  }
  const key = identifierName(property.key);
  return key === undefined
    ? undefined
    : memberType(
        pattern.typeAnnotation?.typeAnnotation ?? undefined,
        key,
        context,
        new Set()
      );
};

/** Whether a call is StyleX's `create`: imported by name, or a namespace's (or default's) `.create`. */
const isStylexCreate = (
  callee: StyleNode | undefined,
  context: StyleContext
): boolean => {
  if (callee?.type === "Identifier") {
    const bound = importOf(context, callee);
    return (
      bound?.source === stylexModule &&
      !bound.typeOnly &&
      bound.imported === "create"
    );
  }
  const bound =
    callee?.type === "MemberExpression" && callee.computed !== true
      ? importOf(context, callee.object)
      : undefined;
  return (
    bound?.source === stylexModule &&
    !bound.typeOnly &&
    (bound.imported === "*" || bound.imported === "default") &&
    identifierName(callee?.property) === "create"
  );
};

/** Whether a `const` holds what StyleX's `create` made. */
const isStylexStyles = (
  variable: Variable | undefined,
  context: StyleContext
): boolean => {
  const [definition] = variable?.defs ?? [];
  const init = definition?.node.init ?? undefined;
  return (
    variable?.defs.length === 1 &&
    definition?.type === "Variable" &&
    definition.parent?.kind === "const" &&
    definition.node.id === definition.name &&
    init?.type === "CallExpression" &&
    isStylexCreate(init.callee, context)
  );
};

/**
 * Whether a name is bound by a named import, by a relative path, from a
 * styles module of an app: the file the path leads to, from this one's
 * folder, is one the rule holds (`isStylesModule`).
 */
const isImportedStyles = (
  object: StyleNode,
  context: StyleContext
): boolean => {
  const bound = importOf(context, object);
  return (
    bound !== undefined &&
    !bound.typeOnly &&
    bound.imported !== "*" &&
    bound.imported !== "default" &&
    /^\.\.?\//u.test(bound.source) &&
    isStylesModule(
      nodePath.resolve(nodePath.dirname(context.filename), bound.source)
    )
  );
};

/** A member of StyleX styles, or the `LayoutStyle` property of a parameter. */
const isPlacementMember = (
  value: StyleNode,
  context: StyleContext
): boolean => {
  const { object } = value;
  if (object?.type !== "Identifier") {
    return false;
  }
  const variable = variableOf(context, object);
  if (isStylexStyles(variable, context) || isImportedStyles(object, context)) {
    return true;
  }
  const key =
    value.computed === true ? undefined : identifierName(value.property);
  return (
    variable !== undefined &&
    key !== undefined &&
    isLayoutStyleType(
      memberType(parameterType(variable, context), key, context, new Set()),
      context
    )
  );
};

/**
 * Whether a name is `undefined`, or a parameter declared `LayoutStyle`.
 * `undefined` is the global's, which a config's globals bind without a
 * declaration: not one the file declares itself.
 */
const isPlacementName = (value: StyleNode, context: StyleContext): boolean => {
  const variable = variableOf(context, value);
  if (value.name === "undefined") {
    return variable === undefined || variable.defs.length === 0;
  }
  return (
    variable !== undefined &&
    isLayoutStyleType(parameterType(variable, context), context)
  );
};

/** What a `const` of that name holds, once, else undefined. */
const constValue = (
  value: StyleNode,
  context: StyleContext,
  seen: Set<Variable>
): StyleNode | undefined => {
  const variable = variableOf(context, value);
  const [definition] = variable?.defs ?? [];
  if (
    variable === undefined ||
    seen.has(variable) ||
    variable.defs.length !== 1 ||
    definition?.type !== "Variable" ||
    definition.parent?.kind !== "const" ||
    definition.node.id !== definition.name
  ) {
    return undefined;
  }
  seen.add(variable);
  return definition.node.init ?? undefined;
};

/** The expressions that wrap a value without changing it: `layout?.wide`, `layout.wide!`. */
const transparent = new Set([
  "ChainExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);

/** Whether it is nothing, or StyleX styles in an array or a condition, each held by `holds`. */
const isPlacementCombination = (
  value: StyleNode,
  holds: (part: StyleNode | null | undefined) => boolean
): boolean => {
  switch (value.type) {
    case "Literal": {
      return value.value === null || value.value === false;
    }
    case "ArrayExpression": {
      const elements = value.elements ?? [];
      return (
        elements.length > 0 &&
        elements.every(
          (element) => element?.type !== "SpreadElement" && holds(element)
        )
      );
    }
    case "ConditionalExpression": {
      return holds(value.consequent) && holds(value.alternate);
    }
    case "LogicalExpression": {
      return value.operator === "&&"
        ? holds(value.right)
        : holds(value.left) && holds(value.right);
    }
    default: {
      return false;
    }
  }
};

/** Whether `value`, given to a component's `style`, is StyleX styles alone (above). */
export const isPlacement = (
  value: StyleNode | undefined,
  context: StyleContext,
  seen = new Set<Variable>()
): boolean => {
  const holds = (part: StyleNode | null | undefined): boolean =>
    part !== null && part !== undefined && isPlacement(part, context, seen);
  if (value === undefined) {
    return false;
  }
  if (transparent.has(value.type)) {
    return holds(value.expression);
  }
  switch (value.type) {
    case "MemberExpression": {
      return isPlacementMember(value, context);
    }
    // `as const` makes it read-only, no other type.
    case "TSAsExpression": {
      return (
        identifierName(value.typeAnnotation?.typeName) === "const" &&
        holds(value.expression)
      );
    }
    // The type checker holds what it satisfies, unlike a cast's.
    case "TSSatisfiesExpression": {
      return (
        isLayoutStyleType(value.typeAnnotation ?? undefined, context) ||
        holds(value.expression)
      );
    }
    case "Identifier": {
      return (
        isPlacementName(value, context) ||
        holds(constValue(value, context, seen))
      );
    }
    default: {
      return isPlacementCombination(value, holds);
    }
  }
};

/** The declarations a type-free export may make: types alone. */
const typeDeclarations = new Set([
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
]);

/** What one `export { … }` or `export const …` of a styles module gives that isn't StyleX styles. */
const refusedOfNamed = (
  statement: StyleNode,
  isStyles: (name: StyleNode | null | undefined) => boolean
): StyleNode[] => {
  const { declaration } = statement;
  const refused: StyleNode[] = [];
  if (declaration?.type === "VariableDeclaration") {
    refused.push(
      ...(declaration.declarations ?? []).filter(
        (declarator) => !isStyles(declarator.id)
      )
    );
  } else if (
    declaration !== null &&
    declaration !== undefined &&
    !typeDeclarations.has(declaration.type)
  ) {
    refused.push(declaration);
  }
  const reexported = (statement.source ?? undefined) !== undefined;
  refused.push(
    ...(statement.specifiers ?? []).filter(
      (specifier) =>
        specifier.exportKind !== "type" &&
        (reexported || !isStyles(specifier.local))
    )
  );
  return refused;
};

/**
 * What a styles module of the app exports that isn't StyleX styles, which
 * the rule refuses there: every export of its own is a `const` made by
 * StyleX's `create`, or one that holds StyleX styles as a page's `style`
 * may (`[styles.one, styles.two] as const`), declared there or named
 * (`export { layout }`); types go freely. Not a default export, not a
 * re-export from elsewhere.
 */
export const stylesModuleExports = (
  program: StyleNode,
  context: StyleContext
): StyleNode[] => {
  const statements = Array.isArray(program.body) ? program.body : [];
  const isStyles = (name: StyleNode | null | undefined): boolean =>
    name?.type === "Identifier" &&
    (isStylexStyles(variableOf(context, name), context) ||
      isPlacement(name, context));
  return statements.flatMap((statement) => {
    if (statement.exportKind === "type") {
      return [];
    }
    switch (statement.type) {
      case "ExportDefaultDeclaration":
      case "ExportAllDeclaration": {
        return [statement];
      }
      case "ExportNamedDeclaration": {
        return refusedOfNamed(statement, isStyles);
      }
      default: {
        return [];
      }
    }
  });
};

/** What a component of the file's own is made by, around its function. */
const componentWrappers = new Set(["memo", "forwardRef"]);

/**
 * The value a component is made from: itself, or what `memo` or
 * `forwardRef` wraps. Undefined for a call of anything else.
 */
const unwrapped = (value: StyleNode | undefined): StyleNode | undefined => {
  if (value?.type !== "CallExpression") {
    return value;
  }
  const { callee } = value;
  const name =
    callee?.type === "MemberExpression"
      ? identifierName(callee.property)
      : identifierName(callee);
  return componentWrappers.has(name ?? "")
    ? unwrapped(value.arguments?.[0])
    : undefined;
};

/** The nodes that are a function or a class, a component's own body. */
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ClassExpression",
  "ClassDeclaration",
]);

/**
 * Whether the file declares it as a component: a function or class, or a
 * `const` holding one, maybe through `memo` or `forwardRef`. Not a `const`
 * holding anything else, an element's name above all
 * (`const Tile = inline ? "span" : "div"`).
 */
const isDeclaredComponent = (definition: Variable["defs"][number]): boolean => {
  if (definition.type === "FunctionName" || definition.type === "ClassName") {
    return true;
  }
  if (definition.type !== "Variable" || definition.parent?.kind !== "const") {
    return false;
  }
  return functionTypes.has(
    unwrapped(definition.node.init ?? undefined)?.type ?? ""
  );
};

/** Whether a parsed value is a node, as far as this file reads one. */
const isNode = (value: unknown): value is StyleNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

/** The modules parsed so far, by file, as of when they last changed. */
const parsed = new Map<string, { mtimeMs: number; body: StyleNode[] }>();

/** The TypeScript files a JavaScript extension of an import stands for. */
const typedExtensions: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/**
 * The file a relative import names, as TypeScript finds it: a `.js` path
 * as `.ts` or `.tsx` (`.jsx` as `.tsx`, `.mjs` as `.mts`, `.cjs` as
 * `.cts`), as written, or with `.tsx` or `.ts`, or its folder's `index`.
 * Undefined if none is.
 */
const moduleFile = (from: string, specifier: string): string | undefined => {
  const base = nodePath.resolve(nodePath.dirname(from), specifier);
  const extension = nodePath.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  const typed = (typedExtensions[extension] ?? []).map(
    (typedExtension) => `${stem}${typedExtension}`
  );
  return [
    ...typed,
    base,
    `${base}.tsx`,
    `${base}.ts`,
    nodePath.join(base, "index.tsx"),
    nodePath.join(base, "index.ts"),
  ].find(
    (file) => statSync(file, { throwIfNoEntry: false })?.isFile() === true
  );
};

/** A module's top-level statements, parsed again only once it changes. */
const statementsOf = (file: string): StyleNode[] => {
  const { mtimeMs } = statSync(file);
  const cached = parsed.get(file);
  if (cached?.mtimeMs === mtimeMs) {
    return cached.body;
  }
  const { program } = parseSync(file, readFileSync(file, "utf-8"));
  const body: unknown[] = program.body;
  const statements = body.filter(isNode);
  parsed.set(file, { mtimeMs, body: statements });
  return statements;
};

/** The name a module-level specifier gives or takes (`B` of `export { A as B }` as `exported`). */
const specifierName = (node: StyleNode | undefined): string | undefined =>
  identifierName(node) ??
  (typeof node?.value === "string" ? node.value : undefined);

/**
 * Where a module's export of a name comes from: a function or class of its
 * own, another module's (by which name), something else of its own (a
 * member of an object, a destructured name, a call), or neither.
 */
type Origin =
  | { readonly kind: "own" }
  | { readonly kind: "other" }
  | { readonly kind: "module"; readonly source: string; readonly name: string }
  | { readonly kind: "absent"; readonly everything: readonly string[] };

const own: Origin = { kind: "own" };
const other: Origin = { kind: "other" };

/** The import a module-level name is bound to, if one is. */
const importOfName = (
  statements: readonly StyleNode[],
  local: string
): Origin | undefined => {
  for (const statement of statements) {
    const specifier =
      statement.type === "ImportDeclaration" && statement.importKind !== "type"
        ? statement.specifiers?.find(
            (candidate) => identifierName(candidate.local) === local
          )
        : undefined;
    const source = statement.source?.value;
    if (specifier !== undefined && typeof source === "string") {
      return { kind: "module", source, name: importedName(specifier) };
    }
  }
  return undefined;
};

/** Whether a pattern binds `name` (`{ Badge }`, `[First]`, `{ a: { Badge } }`). */
const patternBinds = (
  pattern: StyleNode | null | undefined,
  name: string
): boolean => {
  if (pattern === null || pattern === undefined) {
    return false;
  }
  switch (pattern.type) {
    case "Identifier": {
      return identifierName(pattern) === name;
    }
    case "ObjectPattern": {
      // A property's pattern is its value; a rest element is its own.
      return (pattern.properties ?? []).some((property) =>
        patternBinds(isNode(property.value) ? property.value : property, name)
      );
    }
    case "ArrayPattern": {
      return (pattern.elements ?? []).some((element) =>
        patternBinds(element, name)
      );
    }
    case "AssignmentPattern": {
      return patternBinds(pattern.left, name);
    }
    case "RestElement": {
      // Read as a node only if it is one: `argument` is no field of every node.
      const argument: unknown = Reflect.get(pattern, "argument");
      return patternBinds(isNode(argument) ? argument : undefined, name);
    }
    default: {
      return false;
    }
  }
};

/**
 * What a module-level value is, as a component: a function or class of the
 * module's own (an arrow or a function expression too, maybe through `memo`
 * or `forwardRef`), a namespace's member passed on (`Kit.Button`, followed
 * to its module), the name of another to follow, or something else, which
 * is not the module's own.
 */
const valueOrigin = (
  statements: readonly StyleNode[],
  value: StyleNode | null | undefined
): Origin | string => {
  const component = unwrapped(value ?? undefined);
  if (functionTypes.has(component?.type ?? "")) {
    return own;
  }
  if (component?.type === "MemberExpression" && component.computed !== true) {
    const namespace = identifierName(component.object);
    const member = identifierName(component.property);
    const origin =
      namespace === undefined ? undefined : importOfName(statements, namespace);
    return origin?.kind === "module" &&
      origin.name === "*" &&
      member !== undefined
      ? { kind: "module", source: origin.source, name: member }
      : other;
  }
  return identifierName(component) ?? other;
};

/**
 * How the module declares a name of its own: as a function or class, or a
 * `const` holding a value (`init`). A destructured name, a `let` and a name
 * the module doesn't declare are something else.
 */
const declarationOf = (
  statements: readonly StyleNode[],
  name: string
): Origin | { readonly init: StyleNode | null | undefined } => {
  for (const statement of statements) {
    const declaration = statement.type.startsWith("Export")
      ? statement.declaration
      : statement;
    if (
      functionTypes.has(declaration?.type ?? "") &&
      identifierName(declaration?.id ?? undefined) === name
    ) {
      return own;
    }
    const declarators =
      declaration?.type === "VariableDeclaration"
        ? (declaration.declarations ?? [])
        : [];
    for (const declarator of declarators) {
      if (identifierName(declarator.id ?? undefined) === name) {
        return declaration?.kind === "const"
          ? { init: declarator.init }
          : other;
      }
      if (patternBinds(declarator.id, name)) {
        return other;
      }
    }
  }
  return other;
};

/** What a module-level name is bound to, followed through the `const`s that hold it: an import, the module's own, or something else. */
const localOrigin = (
  statements: readonly StyleNode[],
  local: string
): Origin => {
  const seen = new Set<string>();
  let found: Origin | string = local;
  while (typeof found === "string") {
    if (seen.has(found)) {
      return other;
    }
    seen.add(found);
    const imported = importOfName(statements, found);
    if (imported !== undefined) {
      return imported;
    }
    const declaration = declarationOf(statements, found);
    found =
      "kind" in declaration
        ? declaration
        : valueOrigin(statements, declaration.init);
  }
  return found;
};

/** What a module-level value is, as a component, a name it holds followed. */
const declared = (
  statements: readonly StyleNode[],
  value: StyleNode | null | undefined
): Origin => {
  const origin = valueOrigin(statements, value);
  return typeof origin === "string" ? localOrigin(statements, origin) : origin;
};

/** Where an `export { … }` or `export const …` gives `name` from, if it does. */
const namedExportOrigin = (
  statements: readonly StyleNode[],
  statement: StyleNode,
  name: string
): Origin | undefined => {
  const source = statement.source?.value;
  const specifier = statement.specifiers?.find(
    (candidate) => specifierName(candidate.exported ?? undefined) === name
  );
  if (specifier !== undefined) {
    const local = specifierName(specifier.local) ?? name;
    if (typeof source === "string") {
      return { kind: "module", source, name: local };
    }
    return localOrigin(statements, local);
  }
  const { declaration } = statement;
  const declares =
    identifierName(declaration?.id ?? undefined) === name ||
    (declaration?.declarations ?? []).some((declarator) =>
      patternBinds(declarator.id, name)
    );
  return declares ? localOrigin(statements, name) : undefined;
};

/** Where a module's export of `name` comes from, one step: `export { A as B } from`, an import exported, or declared there. */
const exportOrigin = (
  statements: readonly StyleNode[],
  name: string
): Origin => {
  const everything: string[] = [];
  for (const statement of statements) {
    const source = statement.source?.value;
    const typeOnly = statement.exportKind === "type";
    if (statement.type === "ExportAllDeclaration") {
      if (!typeOnly && typeof source === "string") {
        everything.push(source);
      }
    } else if (
      statement.type === "ExportDefaultDeclaration" &&
      name === "default"
    ) {
      return declared(statements, statement.declaration);
    } else if (statement.type === "ExportNamedDeclaration" && !typeOnly) {
      const origin = namedExportOrigin(statements, statement, name);
      if (origin !== undefined) {
        return origin;
      }
    }
  }
  return { kind: "absent", everything };
};

/**
 * The name a module declares its export `name` by: `A` of `export { A as
 * B }`, a default's own (`export default function A`), else `name`.
 */
const localNameOf = (
  statements: readonly StyleNode[],
  name: string
): string | undefined => {
  for (const statement of statements) {
    if (statement.type === "ExportDefaultDeclaration" && name === "default") {
      const { declaration } = statement;
      return (
        identifierName(declaration?.id ?? undefined) ??
        identifierName(declaration ?? undefined)
      );
    }
    const specifier =
      statement.type === "ExportNamedDeclaration" && !statement.source
        ? statement.specifiers?.find(
            (candidate) =>
              specifierName(candidate.exported ?? undefined) === name
          )
        : undefined;
    if (specifier !== undefined) {
      return specifierName(specifier.local);
    }
  }
  return name;
};

/**
 * What a member of a component of the module's own (`Menu.Item`) is, as a
 * component: what the module assigns it once at its top level
 * (`Menu.Item = MenuItem`), as `declared` reads a value. A member the
 * module doesn't assign, assigns more than once, or one of the module's
 * own with members still to follow (`Menu.Item.Icon`) is something else.
 */
const memberOrigin = (
  statements: readonly StyleNode[],
  object: string | undefined,
  members: readonly string[]
): Origin => {
  const values = statements.flatMap((statement) => {
    const assignment =
      statement.type === "ExpressionStatement"
        ? statement.expression
        : undefined;
    const target =
      assignment?.type === "AssignmentExpression" ? assignment.left : undefined;
    return target?.type === "MemberExpression" &&
      target.computed !== true &&
      identifierName(target.object) === object &&
      identifierName(target.property) === members[0] &&
      assignment?.right !== undefined
      ? [assignment.right]
      : [];
  });
  const [value] = values;
  if (object === undefined || values.length !== 1 || value === undefined) {
    return other;
  }
  const origin = declared(statements, value);
  return origin.kind === "own" && members.length > 1 ? other : origin;
};

/** Whether a module is named by a relative path. */
const isRelative = (source: string): boolean => source.startsWith(".");

/**
 * Whether what `source`, imported from `file`, exports as `name` (or its
 * `members`, `Menu.Item`: `memberOrigin`) may be given StyleX styles:
 * Damsko's may; another package's may not; a relative module's may if it
 * declares it, or passes it on from one that may, followed to where it is
 * declared (`export { Button } from "@grasp-os/app-kit/…"` is the kit's).
 * Undefined where the files don't tell: no such module or export, or a
 * loop; the caller refuses those.
 */
const moduleTakesStylex = (
  file: string,
  source: string,
  name: string,
  members: readonly string[],
  seen: Set<string>
): boolean | undefined => {
  if (source.startsWith(damskoModule)) {
    return true;
  }
  if (!isRelative(source)) {
    return false;
  }
  const next = moduleFile(file, source);
  if (next === undefined || seen.has(`${next}#${name}`)) {
    return undefined;
  }
  seen.add(`${next}#${name}`);
  const statements = statementsOf(next);
  const exported = exportOrigin(statements, name);
  const origin =
    exported.kind === "own" && members.length > 0
      ? memberOrigin(statements, localNameOf(statements, name), members)
      : exported;
  if (origin !== exported && origin.kind === "module") {
    return moduleTakesStylex(
      next,
      origin.source,
      origin.name,
      members.slice(1),
      seen
    );
  }
  if (origin.kind === "own" || origin.kind === "other") {
    return origin.kind === "own";
  }
  if (origin.kind === "module") {
    return moduleTakesStylex(next, origin.source, origin.name, members, seen);
  }
  // `export *`: a relative module that has it decides; else any package
  // it passes everything on from may, so each must be Damsko.
  for (const from of origin.everything.filter(isRelative)) {
    const found = moduleTakesStylex(next, from, name, members, seen);
    if (found !== undefined) {
      return found;
    }
  }
  const packages = origin.everything.filter((from) => !isRelative(from));
  return packages.length === 0
    ? undefined
    : packages.every((from) => from.startsWith(damskoModule));
};

/**
 * Whether a component the file declares (`isDeclaredComponent`), or a
 * member of one (`Local.Item`: `memberOrigin`), may be given StyleX styles.
 */
const declaredTakesStylex = (
  definition: Variable["defs"][number],
  context: StyleContext,
  name: string,
  members: readonly string[]
): boolean => {
  if (!isDeclaredComponent(definition) || members.length === 0) {
    return isDeclaredComponent(definition);
  }
  const { body } = context.sourceCode.ast;
  const origin = memberOrigin(Array.isArray(body) ? body : [], name, members);
  return origin.kind === "module"
    ? moduleTakesStylex(
        context.filename,
        origin.source,
        origin.name,
        members.slice(1),
        new Set()
      ) === true
    : origin.kind === "own";
};

/** A component's name (`Menu` of `Menu.Item`), and its members in order. */
const componentPath = (
  name: StyleNode | undefined
): { root: StyleNode | undefined; members: string[] } => {
  let root = name;
  const members: string[] = [];
  while (root?.type === "JSXMemberExpression") {
    const member = root.property?.name;
    members.unshift(typeof member === "string" ? member : "");
    root = root.object;
  }
  return { root, members };
};

/**
 * Whether a component may be given StyleX styles: one of Damsko's
 * (`@grasp-os/ui/…`), one of the feature's own (imported by a relative
 * path, typed to take Damsko's `LayoutStyle` and pass it on; declared
 * there or passed on from such a module or Damsko, never another
 * package's: `moduleTakesStylex`), or one the file declares
 * (`isDeclaredComponent`). Not one of any other package, the kit's or the
 * router's `Link`, whose `style` is an inline style, nor a name that holds
 * an element's (`Tile` of `"div"`).
 */
export const takesStylex = (
  name: StyleNode | undefined,
  context: StyleContext
): boolean => {
  const { root, members } = componentPath(name);
  if (root?.type !== "JSXIdentifier" || typeof root.name !== "string") {
    return false;
  }
  const variable = variableOf(context, root);
  const [definition] = variable?.defs ?? [];
  if (variable?.defs.length !== 1 || definition === undefined) {
    return false;
  }
  if (definition.type !== "ImportBinding") {
    return declaredTakesStylex(definition, context, root.name, members);
  }
  const source = definition.parent?.source?.value;
  if (
    typeof source !== "string" ||
    definition.parent?.importKind === "type" ||
    definition.node.importKind === "type"
  ) {
    return false;
  }
  // A namespace's member (`Parts.Save`) is the export; a member of a
  // component (`Menu.Item`) must be one its module assigns.
  const imported = importedName(definition.node);
  const [exported = "", ...rest] =
    imported === "*" ? members : [imported, ...members];
  return (
    moduleTakesStylex(context.filename, source, exported, rest, new Set()) ===
    true
  );
};
