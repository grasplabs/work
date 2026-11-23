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
 * own (by a relative path) or one the file declares; never an element of
 * the page, a component of another package (the kit's, the router's
 * `Link`) or a name holding an element's.
 */
import nodePath from "node:path";

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

/** Whether a name is `undefined`, or a parameter declared `LayoutStyle`. */
const isPlacementName = (value: StyleNode, context: StyleContext): boolean => {
  const variable = variableOf(context, value);
  if (value.name === "undefined") {
    return variable === undefined;
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
 * Whether the file declares it as a component: a function or class, or a
 * `const` holding one, maybe through `memo` or `forwardRef`. Not a `const`
 * holding anything else, an element's name above all
 * (`const Tile = inline ? "span" : "div"`).
 */
const isDeclaredComponent = (definition: Variable["defs"][number]): boolean => {
  if (definition.type === "FunctionName" || definition.type === "ClassName") {
    return true;
  }
  let init = definition.node.init ?? undefined;
  if (
    definition.type !== "Variable" ||
    definition.parent?.kind !== "const" ||
    init === undefined
  ) {
    return false;
  }
  if (init.type === "CallExpression") {
    const { callee } = init;
    const name =
      callee?.type === "MemberExpression"
        ? identifierName(callee.property)
        : identifierName(callee);
    init = componentWrappers.has(name ?? "")
      ? (init.arguments?.[0] ?? undefined)
      : undefined;
  }
  return (
    init?.type === "ArrowFunctionExpression" ||
    init?.type === "FunctionExpression" ||
    init?.type === "ClassExpression"
  );
};

/**
 * Whether a component may be given StyleX styles: one of Damsko's
 * (`@grasp-os/ui/…`), one of the feature's own (imported by a relative
 * path, typed to take Damsko's `LayoutStyle` and pass it on), or one the
 * file declares (`isDeclaredComponent`). Not one of any other package,
 * the kit's or the router's `Link`, whose `style` is an inline style, nor
 * a name that holds an element's (`Tile` of `"div"`).
 */
export const takesStylex = (
  name: StyleNode | undefined,
  context: StyleContext
): boolean => {
  let root = name;
  while (root?.type === "JSXMemberExpression") {
    root = root.object;
  }
  if (root?.type !== "JSXIdentifier" || typeof root.name !== "string") {
    return false;
  }
  const variable = variableOf(context, root);
  const [definition] = variable?.defs ?? [];
  if (variable?.defs.length !== 1 || definition === undefined) {
    return false;
  }
  if (definition.type !== "ImportBinding") {
    return isDeclaredComponent(definition);
  }
  const source = definition.parent?.source?.value;
  return (
    typeof source === "string" &&
    definition.parent?.importKind !== "type" &&
    definition.node.importKind !== "type" &&
    (source.startsWith(damskoModule) || source.startsWith("."))
  );
};
