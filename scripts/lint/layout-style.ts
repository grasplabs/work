/**
 * Whether a `style` value is Damsko's layout seam (grasp/no-inline-styles,
 * grasp-plugin.ts): StyleX styles, which a component's `LayoutStyle` prop
 * takes, never an inline style. The linter reads no types, so the value
 * is held to what can only be such a style, read from the file itself:
 *
 * - a member of an object `stylex.create` made in a `const` of the file
 *   (`layout.wide`, `layout[size]`);
 * - a parameter, or a property of one, whose declared type is Damsko's
 *   `LayoutStyle` (imported from `@grasp-os/ui/…`), there or in an
 *   interface or type alias of the file it names, and never assigned;
 * - a `const` that holds one of these;
 * - an array of these, `cond && style`, `a ?? b`, `cond ? a : b`, and
 *   `undefined`, `null` or `false` among them.
 *
 * Anything else, an object literal above all, is not.
 */

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
  typeAnnotation?: StyleNode | null;
  typeName?: StyleNode;
  typeArguments?: StyleNode | null;
  types?: StyleNode[];
  members?: StyleNode[];
  body?: StyleNode | StyleNode[];
  declaration?: StyleNode | null;
  kind?: string;
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
  sourceCode: { ast: StyleNode; getScope: (node: StyleNode) => Scope };
}

/** What the file's imports name: StyleX's `create`, Damsko's `LayoutStyle`. */
export interface Imported {
  /** `stylex` of `import * as stylex from "@stylexjs/stylex"`. */
  readonly stylex: ReadonlySet<string>;
  /** `create` of `import { create } from "@stylexjs/stylex"`. */
  readonly create: ReadonlySet<string>;
  /** `LayoutStyle` of `import type { LayoutStyle } from "@grasp-os/ui/…"`. */
  readonly layoutStyle: ReadonlySet<string>;
}

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

/** Whether anything assigns to it after it is declared. */
const isWritten = (variable: Variable): boolean =>
  variable.references.some(
    (reference) => reference.isWrite() && reference.init !== true
  );

const identifierName = (node: StyleNode | undefined): string | undefined =>
  node?.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;

/** The file's interface or type alias of that name, exported or not. */
const typeDeclaration = (
  program: StyleNode,
  name: string
): StyleNode | undefined => {
  const statements = Array.isArray(program.body) ? program.body : [];
  for (const statement of statements) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? (statement.declaration ?? undefined)
        : statement;
    if (
      (declaration?.type === "TSInterfaceDeclaration" ||
        declaration?.type === "TSTypeAliasDeclaration") &&
      identifierName(declaration.id ?? undefined) === name
    ) {
      return declaration;
    }
  }
  return undefined;
};

/** Whether a type is `LayoutStyle`, maybe with `undefined` or `null`. */
const isLayoutStyleType = (
  type: StyleNode | undefined,
  imported: Imported
): boolean => {
  if (type?.type === "TSTypeReference") {
    const name = identifierName(type.typeName);
    return (
      name !== undefined &&
      imported.layoutStyle.has(name) &&
      (type.typeArguments ?? undefined) === undefined
    );
  }
  if (type?.type === "TSUnionType") {
    const types = type.types ?? [];
    return (
      types.some((member) => isLayoutStyleType(member, imported)) &&
      types.every(
        (member) =>
          member.type === "TSUndefinedKeyword" ||
          member.type === "TSNullKeyword" ||
          isLayoutStyleType(member, imported)
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
  program: StyleNode,
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
        const found = memberType(part, key, program, seen);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }
    case "TSTypeReference": {
      const name = identifierName(type.typeName);
      const declaration =
        name === undefined ? undefined : typeDeclaration(program, name);
      if (declaration?.type === "TSInterfaceDeclaration") {
        return memberType(
          Array.isArray(declaration.body) ? undefined : declaration.body,
          key,
          program,
          seen
        );
      }
      return memberType(
        declaration?.typeAnnotation ?? undefined,
        key,
        program,
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
  program: StyleNode
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
        program,
        new Set()
      );
};

/** Whether a `const` holds what `stylex.create` made. */
const isStylexStyles = (variable: Variable, imported: Imported): boolean => {
  const [definition] = variable.defs;
  const init = definition?.node.init ?? undefined;
  if (
    variable.defs.length !== 1 ||
    definition?.type !== "Variable" ||
    definition.parent?.kind !== "const" ||
    definition.node.id !== definition.name ||
    init?.type !== "CallExpression"
  ) {
    return false;
  }
  const { callee } = init;
  if (callee?.type === "Identifier") {
    return imported.create.has(identifierName(callee) ?? "");
  }
  return (
    callee?.type === "MemberExpression" &&
    callee.computed !== true &&
    imported.stylex.has(identifierName(callee.object) ?? "") &&
    identifierName(callee.property) === "create"
  );
};

/** A member of StyleX styles, or the `LayoutStyle` property of a parameter. */
const isPlacementMember = (
  value: StyleNode,
  context: StyleContext,
  imported: Imported
): boolean => {
  const { object } = value;
  const variable =
    object?.type === "Identifier" ? variableOf(context, object) : undefined;
  if (variable === undefined) {
    return false;
  }
  if (isStylexStyles(variable, imported)) {
    return true;
  }
  const key =
    value.computed === true ? undefined : identifierName(value.property);
  const program = context.sourceCode.ast;
  return (
    key !== undefined &&
    isLayoutStyleType(
      memberType(parameterType(variable, program), key, program, new Set()),
      imported
    )
  );
};

/** Whether a name is `undefined`, or a parameter declared `LayoutStyle`. */
const isPlacementName = (
  value: StyleNode,
  context: StyleContext,
  imported: Imported
): boolean => {
  const variable = variableOf(context, value);
  if (value.name === "undefined") {
    return variable === undefined;
  }
  return (
    variable !== undefined &&
    isLayoutStyleType(parameterType(variable, context.sourceCode.ast), imported)
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

/** Whether `value`, given to a component's `style`, is StyleX styles alone (above). */
export const isPlacement = (
  value: StyleNode | undefined,
  context: StyleContext,
  imported: Imported,
  seen = new Set<Variable>()
): boolean => {
  const holds = (part: StyleNode | null | undefined): boolean =>
    part !== null &&
    part !== undefined &&
    isPlacement(part, context, imported, seen);
  if (value === undefined) {
    return false;
  }
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
    case "MemberExpression": {
      return isPlacementMember(value, context, imported);
    }
    case "Identifier": {
      return (
        isPlacementName(value, context, imported) ||
        holds(constValue(value, context, seen))
      );
    }
    default: {
      return false;
    }
  }
};
