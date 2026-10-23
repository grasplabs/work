/**
 * The compiler's own lint rules for screens, beside @shadcn/lint's (which
 * hold classes, colours and the `style` prop to the kit): every other way
 * a screen could style itself outside the design system, or load what
 * the frame would refuse anyway, refused where it is written, each with
 * what to do instead. The frame's sandbox and CSP still hold at run time
 * (core's security-headers.ts); these say so at build, where it can be
 * fixed.
 */
import type { Rule } from "eslint";

/** Added to every message: a screen styles itself with the kit. */
const instead =
  "Style screens with the kit's components and theme classes (@grasp-os/ui).";

/** Elements whose `src`-like attributes load a resource into the frame. */
const loadingElements = new Set([
  "img",
  "image",
  "video",
  "audio",
  "source",
  "track",
  "iframe",
  "embed",
  "object",
  "script",
  "input",
]);

/** The attributes of those elements that load a resource. */
const loadingAttributes = new Set(["src", "srcSet", "poster", "data", "href"]);

/** A URL that reaches outside the frame: another origin, or any scheme. */
const remote = /^\s*(?:[a-z][a-z\d+.-]*:|\/\/)/iu;

/** A URL the frame's CSP serves from the page itself. */
const local = /^\s*(?:data|blob):/iu;

/** Whitespace, as HTML's srcset grammar reads it. */
const srcSetSpace = /\s/u;

/**
 * A `srcSet`'s candidate URLs, as HTML parses them (§4.8.4.3.1): each a
 * run up to whitespace, after any whitespace and commas, ending the
 * candidate if it ends in commas; else its descriptors follow, up to the
 * next comma outside parentheses, which don't nest. A `data:` URL keeps
 * its own commas.
 */
const srcSetUrls = (value: string): string[] => {
  const urls: string[] = [];
  let at = 0;
  while (at < value.length) {
    while (at < value.length && /[\s,]/u.test(value.charAt(at))) {
      at += 1;
    }
    const start = at;
    while (at < value.length && !srcSetSpace.test(value.charAt(at))) {
      at += 1;
    }
    const url = value.slice(start, at);
    const trimmed = url.replace(/,+$/u, "");
    if (trimmed !== "") {
      urls.push(trimmed);
    }
    if (trimmed === url) {
      // HTML's descriptor states: "(" enters parentheses, the first ")"
      // leaves them (they don't nest), a comma outside ends the candidate.
      let inParens = false;
      while (at < value.length) {
        const char = value.charAt(at);
        if (char === "," && !inParens) {
          break;
        }
        if (char === "(") {
          inParens = true;
        } else if (char === ")") {
          inParens = false;
        }
        at += 1;
      }
    }
  }
  return urls;
};

/** The URLs an attribute loads: a `srcSet`'s candidates each, else its value. */
const urlsOf = (attribute: string, value: string): string[] =>
  attribute === "srcSet" ? srcSetUrls(value) : [value];

/** DOM properties that write a stylesheet or styles directly. */
const styleWrites = new Set(["cssText", "innerHTML", "outerHTML"]);

/** DOM members that reach stylesheets or the document's head. */
const sheetMembers = new Set([
  "adoptedStyleSheets",
  "styleSheets",
  "insertRule",
  "replaceSync",
  "head",
]);

/** A field of an AST node, read without trusting its shape. */
const get = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** An AST node: anything with a `type`. */
const isRuleNode = (value: unknown): value is Rule.Node =>
  typeof get(value, "type") === "string";

/** A JSX element's or attribute's name, as written. */
const jsxName = (node: unknown): string | undefined => {
  const name = get(node, "name");
  return get(node, "type") === "JSXIdentifier" && typeof name === "string"
    ? name
    : undefined;
};

/** A member expression's property name, when written as a name or string. */
const memberName = (node: unknown): string | undefined => {
  const property = get(node, "property");
  const type = get(property, "type");
  if (get(node, "computed") !== true && type === "Identifier") {
    const name = get(property, "name");
    return typeof name === "string" ? name : undefined;
  }
  const value = get(property, "value");
  return type === "Literal" && typeof value === "string" ? value : undefined;
};

/** A string a literal or a template without expressions holds. */
const stringOf = (node: unknown): string | undefined => {
  const type = get(node, "type");
  const value = get(node, "value");
  if (type === "Literal" && typeof value === "string") {
    return value;
  }
  if (type === "JSXExpressionContainer") {
    return stringOf(get(node, "expression"));
  }
  const quasis = get(node, "quasis");
  const expressions = get(node, "expressions");
  if (
    type === "TemplateLiteral" &&
    Array.isArray(quasis) &&
    Array.isArray(expressions) &&
    expressions.length === 0
  ) {
    const cooked = get(get(quasis[0], "value"), "cooked");
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
};

/**
 * Whether member `name` of `object` reaches stylesheets: `head` only as
 * the document's, since it is a common name for other things.
 */
const isSheetMember = (
  name: string | undefined,
  object: unknown
): name is string =>
  name !== undefined &&
  sheetMembers.has(name) &&
  (name !== "head" ||
    (get(object, "type") === "Identifier" &&
      get(object, "name") === "document"));

/** `x.style`, read as the left of an assignment or a call. */
const isStyleObject = (node: unknown): boolean =>
  get(node, "type") === "MemberExpression" && memberName(node) === "style";

/** A type annotation that names a DOM element, node or style declaration. */
const elementType = /\b(?:\w*Element|Node|EventTarget|CSSStyleDeclaration)\b/u;

/** Literals that are never an element, however they're asserted. */
const plainValues = new Set([
  "ObjectExpression",
  "ArrayExpression",
  "Literal",
  "TemplateLiteral",
]);

/** Type assertions around a value: `x as T`, `x satisfies T`, `x!`. */
const assertions = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

/** A value without the type assertions around it. */
const unwrap = (node: unknown): unknown =>
  assertions.has(String(get(node, "type")))
    ? unwrap(get(node, "expression"))
    : node;

/** A property's key, when written as a name or string. */
const keyOf = (property: unknown): string | undefined => {
  const key = get(property, "key");
  const name = get(key, "name");
  const value = get(key, "value");
  if (get(property, "computed") !== true && typeof name === "string") {
    return name;
  }
  return typeof value === "string" ? value : undefined;
};

/** The definition in scope of the variable `name`, if any. */
const definitionOf = (
  context: Rule.RuleContext,
  node: Rule.Node,
  name: string
) => {
  let scope: ReturnType<typeof context.sourceCode.getScope> | null =
    context.sourceCode.getScope(node);
  while (scope !== null && !scope.set.has(name)) {
    scope = scope.upper;
  }
  return scope?.set.get(name)?.defs[0];
};

/** What an identifier is bound to, when declared as `const x = value`. */
const bindingOf = (
  context: Rule.RuleContext,
  node: Rule.Node,
  identifier: unknown
): unknown => {
  const name = get(identifier, "name");
  if (get(identifier, "type") !== "Identifier" || typeof name !== "string") {
    return undefined;
  }
  const definition = definitionOf(context, node, name);
  const declarator = definition?.node;
  return definition?.type === "Variable" &&
    get(declarator, "id") === definition.name
    ? unwrap(get(declarator, "init"))
    : undefined;
};

/** What a value is known to be: plain data, or a variable of a declared type. */
type Known = "plain" | "element-typed" | "data-typed" | undefined;

/** How many bindings and properties `knownOf` follows before giving up. */
const maxSteps = 8;

/** A property of an object literal named `name`, written as a name or string. */
const propertyNamed = (object: unknown, name: string): unknown => {
  const properties = get(object, "properties");
  if (!Array.isArray(properties)) {
    return undefined;
  }
  // The last one wins, as at run time; a spread after it may override it.
  for (const property of properties.toReversed()) {
    if (get(property, "type") !== "Property") {
      return undefined;
    }
    if (keyOf(property) === name) {
      return property;
    }
  }
  return undefined;
};

/**
 * What a value is known to be, read from the source: a literal; a
 * variable bound directly to one or annotated with a type; or a property,
 * written as a name, of an object literal reached that way. Anything
 * else, a call or a property of something unknown, is unknown.
 */
const knownOf = (
  context: Rule.RuleContext,
  node: Rule.Node,
  value: unknown,
  steps = 0
): Known => {
  const bare = unwrap(value);
  const type = get(bare, "type");
  if (steps > maxSteps) {
    return undefined;
  }
  if (plainValues.has(String(type))) {
    return "plain";
  }
  if (type === "MemberExpression") {
    const name = memberName(bare);
    const object = unwrap(get(bare, "object"));
    if (name === undefined) {
      return undefined;
    }
    const literal =
      get(object, "type") === "ObjectExpression"
        ? object
        : bindingOf(context, node, object);
    const property = propertyNamed(literal, name);
    return property === undefined
      ? undefined
      : knownOf(context, node, get(property, "value"), steps + 1);
  }
  const name = get(bare, "name");
  if (type !== "Identifier" || typeof name !== "string") {
    return undefined;
  }
  const definition = definitionOf(context, node, name);
  const annotation = get(
    get(definition?.name, "typeAnnotation"),
    "typeAnnotation"
  );
  if (isRuleNode(annotation)) {
    return elementType.test(context.sourceCode.getText(annotation))
      ? "element-typed"
      : "data-typed";
  }
  const init = bindingOf(context, node, bare);
  return init === undefined
    ? undefined
    : knownOf(context, node, init, steps + 1);
};

/**
 * Whether the value whose `style` is written may be a DOM element. The
 * lint has no type information, so this reads what the source says: no
 * when that value itself is known to be plain data (a literal, a
 * variable bound to one or typed as something other than the DOM, or a
 * property of an object literal holding a literal), as with
 * `const options = { style: "compact" }; options.style = "expanded"`;
 * yes otherwise, so `ref.current.style`, an unannotated parameter's, or
 * `elements.button.style` where `button` holds `document.querySelector`.
 */
const mayBeElement = (
  context: Rule.RuleContext,
  node: Rule.Node,
  object: unknown
): boolean => {
  const known = knownOf(context, node, object);
  return known === undefined || known === "element-typed";
};

const noStyleEscapes: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Refuse styling a screen outside the design system through the DOM or raw HTML",
    },
    schema: false,
    messages: {
      innerHtml: `dangerouslySetInnerHTML writes raw HTML, styles included, past the design system and React. Render elements instead. ${instead}`,
      styleWrite: `Writing an element's style ({{what}}) styles it outside the design system. Toggle a theme class instead, or set a CSS custom property the kit reads through className. ${instead}`,
      createElement: `document.createElement("{{element}}") adds a stylesheet outside the design system. ${instead}`,
      sheet: `{{member}} reaches the frame's stylesheets or head, outside the design system. ${instead}`,
      constructedSheet: `A constructed stylesheet (new CSSStyleSheet) styles the screen outside the design system. ${instead}`,
    },
  },
  create: (context) => ({
    JSXAttribute: (node: Rule.Node) => {
      if (jsxName(get(node, "name")) === "dangerouslySetInnerHTML") {
        context.report({ node, messageId: "innerHtml" });
      }
    },
    AssignmentExpression: (node: Rule.Node) => {
      const left = get(node, "left");
      if (get(left, "type") !== "MemberExpression") {
        return;
      }
      const name = memberName(left);
      const object = get(left, "object");
      const writesStyle =
        (name === "style" && mayBeElement(context, node, object)) ||
        (isStyleObject(object) &&
          mayBeElement(context, node, get(object, "object")));
      if (writesStyle) {
        context.report({
          node,
          messageId: "styleWrite",
          data: { what: name === "style" ? "style" : `style.${name ?? "…"}` },
        });
      } else if (name !== undefined && styleWrites.has(name)) {
        context.report({ node, messageId: "styleWrite", data: { what: name } });
      } else if (isSheetMember(name, get(left, "object"))) {
        context.report({ node, messageId: "sheet", data: { member: name } });
      }
    },
    CallExpression: (node: Rule.Node) => {
      const callee = get(node, "callee");
      const args = get(node, "arguments");
      if (get(callee, "type") !== "MemberExpression") {
        return;
      }
      const name = memberName(callee);
      const first = Array.isArray(args) ? stringOf(args[0]) : undefined;
      if (name === "setAttribute" && first?.toLowerCase() === "style") {
        context.report({
          node,
          messageId: "styleWrite",
          data: { what: 'setAttribute("style")' },
        });
      } else if (
        name === "setProperty" &&
        isStyleObject(get(callee, "object")) &&
        mayBeElement(context, node, get(get(callee, "object"), "object"))
      ) {
        context.report({
          node,
          messageId: "styleWrite",
          data: { what: "style.setProperty" },
        });
      } else if (
        name === "createElement" &&
        (first?.toLowerCase() === "style" || first?.toLowerCase() === "link")
      ) {
        context.report({
          node,
          messageId: "createElement",
          data: { element: first.toLowerCase() },
        });
      } else if (isSheetMember(name, get(callee, "object"))) {
        context.report({ node, messageId: "sheet", data: { member: name } });
      }
    },
    MemberExpression: (node: Rule.Node) => {
      const name = memberName(node);
      const parent = get(node, "parent");
      const parentType = get(parent, "type");
      // Reported once, as the call or assignment, where those are.
      const reportedThere =
        (parentType === "CallExpression" && get(parent, "callee") === node) ||
        (parentType === "AssignmentExpression" && get(parent, "left") === node);
      if (!reportedThere && isSheetMember(name, get(node, "object"))) {
        context.report({ node, messageId: "sheet", data: { member: name } });
      }
    },
    NewExpression: (node: Rule.Node) => {
      const callee = get(node, "callee");
      if (
        get(callee, "type") === "Identifier" &&
        get(callee, "name") === "CSSStyleSheet"
      ) {
        context.report({ node, messageId: "constructedSheet" });
      }
    },
  }),
};

const noRemoteResources: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Refuse loading a stylesheet or a remote resource into a screen",
    },
    schema: false,
    messages: {
      link: `A <link> loads a stylesheet or resource into the screen, outside the design system: the screen's frame never loads one. ${instead}`,
      remote: `<{{element}} {{attribute}}="{{url}}"> loads a resource from outside the screen, which its frame never loads. Use a file the App stores (a data: or blob: URL), or an icon from lucide-react.`,
    },
  },
  create: (context) => ({
    JSXOpeningElement: (node: Rule.Node) => {
      const name = jsxName(get(node, "name"));
      if (name === "link") {
        context.report({ node, messageId: "link" });
        return;
      }
      if (name === undefined || !loadingElements.has(name)) {
        return;
      }
      const attributes: unknown = get(node, "attributes");
      if (!Array.isArray(attributes)) {
        return;
      }
      for (const attribute of attributes) {
        if (
          !isRuleNode(attribute) ||
          get(attribute, "type") !== "JSXAttribute"
        ) {
          continue;
        }
        const attributeName = jsxName(get(attribute, "name"));
        const value = stringOf(get(attribute, "value"));
        if (
          attributeName === undefined ||
          !loadingAttributes.has(attributeName) ||
          value === undefined
        ) {
          continue;
        }
        const url = urlsOf(attributeName, value).find(
          (candidate) => remote.test(candidate) && !local.test(candidate)
        );
        if (url !== undefined) {
          context.report({
            node: attribute,
            messageId: "remote",
            data: { element: name, attribute: attributeName, url },
          });
        }
      }
    },
  }),
};

/** Helpers whose string arguments are class lists. */
const classHelpers = new Set([
  "cn",
  "clsx",
  "cva",
  "twMerge",
  "twJoin",
  "classNames",
]);

/** Nodes a class list passes through on its way to a helper or className. */
const throughClassList = new Set([
  "ArrayExpression",
  "ConditionalExpression",
  "LogicalExpression",
  "ObjectExpression",
  "Property",
  "JSXExpressionContainer",
]);

/** A property the walk passed: the string as its key, or in its value. */
interface Passed {
  role: "key" | "value";
  key: string | undefined;
}

/** cva's keys whose string values are classes. */
const cvaClassKeys = new Set(["class", "className"]);

/**
 * Whether a helper emits a string reached through `passed` (innermost
 * first) as classes. clsx and its kin emit an object's keys, its values
 * being conditions; cva emits its variants' values and a compound
 * variant's `class`, its keys being variant names.
 */
const helperEmits = (helper: string, passed: readonly Passed[]): boolean => {
  if (passed.length === 0) {
    return true;
  }
  if (helper !== "cva") {
    return passed.every(({ role }) => role === "key");
  }
  const [innermost] = passed;
  return (
    passed.every(({ role }) => role === "value") &&
    (cvaClassKeys.has(innermost?.key ?? "") ||
      passed.some(({ key }) => key === "variants"))
  );
};

/** Whether a string at `child` of `parent` can emerge from it as a class. */
const emerges = (parent: unknown, child: unknown): boolean => {
  const type = get(parent, "type");
  if (type === "ConditionalExpression") {
    return get(parent, "test") !== child;
  }
  // `a && "x"` gives `a` only when it's falsy: never a class.
  if (type === "LogicalExpression") {
    return get(parent, "operator") !== "&&" || get(parent, "left") !== child;
  }
  return typeof type === "string" && throughClassList.has(type);
};

/**
 * Whether a string literal is a class list: one a class helper emits as
 * classes (`cn("…")`, `cn({ "…": on })`, `cn(on && "…")`), or a part of
 * a `className` built with a condition. Not any string: prose such as
 * `cn({ "font-bold": notice && "Saved!" })` ends in `!` too.
 */
const inClassList = (node: unknown): boolean => {
  const passed: Passed[] = [];
  let child = node;
  let parent = get(node, "parent");
  while (typeof get(parent, "type") === "string") {
    const type = get(parent, "type");
    if (type === "CallExpression") {
      const callee = get(parent, "callee");
      const helper = get(callee, "name");
      return (
        callee !== child &&
        get(callee, "type") === "Identifier" &&
        typeof helper === "string" &&
        classHelpers.has(helper) &&
        helperEmits(helper, passed)
      );
    }
    if (type === "JSXAttribute") {
      return (
        jsxName(get(parent, "name")) === "className" && passed.length === 0
      );
    }
    if (!emerges(parent, child)) {
      return false;
    }
    if (type === "Property") {
      passed.push({
        role: get(parent, "key") === child ? "key" : "value",
        key: keyOf(parent),
      });
    }
    child = parent;
    parent = get(parent, "parent");
  }
  return false;
};

/** A literal that is a `className`'s whole value, which the attribute checks. */
const isAttributeValue = (node: unknown): boolean => {
  const parent = get(node, "parent");
  return (
    get(parent, "type") === "JSXAttribute" ||
    (get(parent, "type") === "JSXExpressionContainer" &&
      get(get(parent, "parent"), "type") === "JSXAttribute")
  );
};

/**
 * A class with Tailwind's important modifier: leading, after any variants
 * (`!p-2`, `md:!flex`), or trailing (`p-2!`).
 */
const important = /(?:^|:)!|!$/u;

const noImportant: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Refuse Tailwind's important modifier, which overrides the kit's own styles",
    },
    schema: false,
    messages: {
      important: `"{{name}}" uses the important modifier (!), which overrides the kit's own styles. Use the component's variant or size, or a theme class it takes. ${instead}`,
    },
  },
  create: (context) => {
    const check = (node: Rule.Node, text: string): void => {
      for (const name of text.split(/\s+/u)) {
        if (name.length > 1 && important.test(name)) {
          context.report({ node, messageId: "important", data: { name } });
        }
      }
    };
    return {
      JSXAttribute: (node: Rule.Node) => {
        if (jsxName(get(node, "name")) !== "className") {
          return;
        }
        const value = stringOf(get(node, "value"));
        if (value !== undefined) {
          check(node, value);
        }
      },
      // A template's static parts, in a `className` or a class helper;
      // one with no expressions in a `className` the attribute checks.
      TemplateLiteral: (node: Rule.Node) => {
        const quasis = get(node, "quasis");
        const expressions = get(node, "expressions");
        if (
          !Array.isArray(quasis) ||
          (Array.isArray(expressions) &&
            expressions.length === 0 &&
            isAttributeValue(node)) ||
          !inClassList(node)
        ) {
          return;
        }
        for (const quasi of quasis) {
          const cooked = get(get(quasi, "value"), "cooked");
          if (typeof cooked === "string") {
            check(node, cooked);
          }
        }
      },
      // Class lists built with `cn(…)` or a condition.
      Literal: (node: Rule.Node) => {
        const value = get(node, "value");
        if (
          typeof value === "string" &&
          !isAttributeValue(node) &&
          inClassList(node)
        ) {
          check(node, value);
        }
      },
    };
  },
};

/** The rules, as an ESLint plugin named `grasp`. */
export const designRules = {
  rules: {
    "no-style-escapes": noStyleEscapes,
    "no-remote-resources": noRemoteResources,
    "no-important": noImportant,
  },
};

/** The rules on, as errors. */
export const designRuleLevels = {
  "grasp/no-style-escapes": "error",
  "grasp/no-remote-resources": "error",
  "grasp/no-important": "error",
} as const;
