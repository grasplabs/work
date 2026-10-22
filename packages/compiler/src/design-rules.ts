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
 * next comma outside parentheses. A `data:` URL keeps its own commas.
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
      let depth = 0;
      while (at < value.length) {
        const char = value.charAt(at);
        if (char === "," && depth === 0) {
          break;
        }
        if (char === "(") {
          depth += 1;
        } else if (char === ")" && depth > 0) {
          depth -= 1;
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
      if (name === "style" || isStyleObject(get(left, "object"))) {
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
        isStyleObject(get(callee, "object")) &&
        name === "setProperty"
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

/**
 * Whether a string literal is a class list: an argument, however nested
 * in arrays, objects and conditions, of a class helper (`cn("…")`), or
 * a part of a `className` built with a condition. Not any string: prose
 * such as "Saved!" ends in `!` too.
 */
const inClassList = (node: unknown): boolean => {
  let child = node;
  let parent = get(node, "parent");
  while (typeof get(parent, "type") === "string") {
    const type = get(parent, "type");
    if (type === "CallExpression") {
      const callee = get(parent, "callee");
      return (
        get(parent, "callee") !== child &&
        get(callee, "type") === "Identifier" &&
        classHelpers.has(String(get(callee, "name")))
      );
    }
    if (type === "JSXAttribute") {
      return jsxName(get(parent, "name")) === "className";
    }
    // An object's keys are classes (clsx) and its values may be (cva);
    // a condition's test is not.
    if (
      typeof type !== "string" ||
      !throughClassList.has(type) ||
      (type === "ConditionalExpression" && get(parent, "test") === child)
    ) {
      return false;
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
