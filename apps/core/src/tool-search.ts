import type { ToolClass } from "@grasp-os/shared/connect";
import { isRecord } from "@grasp-os/shared/json";
import { create, insertMultiple, search } from "@orama/orama";

// Tool search for the chat's agent (`env.connections.search` and
// `describe`): one connector can bring hundreds of tools, too many to list.
// The tools are filtered first, then ranked: the index holds only the tools
// the agent may call for its person now, or ask for, each with its class on
// for them (agent-connections.ts), so its statistics never count a tool the
// person can't see. It is Orama's BM25, in memory, built for each search
// and dropped after it, the fields weighted name, tag, description, then
// argument names, without words as common as "a" or "to" (`ignored`).
// Orama matches each word of a query as the start of a word, so a short
// one still matches more than it means: "up" finds "update" too. It is
// built for each search because it holds only the tools that person may
// reach then; a connector of many thousands of tools may need it kept.
// Search only decides what the model is shown: every call still names
// the real tool through `env.connections.call`, checked as any.

/** A tool as search ranks and describes it. */
export interface SearchableTool {
  /** What a call names the connection by; a connection to ask for by its ID. */
  connection: string;
  action: string;
  /** Its provider and its action's family, such as `microsoft mail`. */
  tag: string;
  toolClass: ToolClass;
  /** That the chat must ask for its connection first (`request`). */
  ask: boolean;
  description: string | null;
  /** The JSON Schemas of its input and output, as JSON text, if known. */
  input: string | null;
  output: string | null;
}

/** One match of a query, as the chat's code reads it. */
export interface ToolMatch {
  connection: string;
  action: string;
  summary: string;
  class: ToolClass;
  /** Its input's type, its top level only. */
  input: string;
  /** Set when the chat must ask for its connection before calling it. */
  ask?: true;
}

/** What one query found. */
export interface ToolSearchResult {
  query: string;
  matches: ToolMatch[];
  /** A few more tools that matched, after those, by connection and action. */
  related: Pick<ToolMatch, "connection" | "action" | "ask">[];
}

/** Most matches a query answers with. */
const maxMatches = 5;

/** Most more names a query answers with after its matches. */
const maxRelated = 3;

/** Most characters of a match's summary. */
const maxSummaryChars = 160;

/** Deepest a described type nests before it reads `unknown`. */
const maxTypeDepth = 8;

/**
 * Words neither indexed nor searched for: articles and connectives, which
 * say nothing of a tool. Not "off", "up" or "all": a tool's name can.
 */
const ignored = [
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
];

/**
 * How much each field weighs: a tool's name says most what it does, its
 * argument names least.
 */
const boost = { name: 4, tag: 3, description: 2, args: 1 };

/**
 * `text` as words Orama's tokenizer splits: its own splitter keeps `_`
 * and `-` inside a word, and a name runs words together
 * (`HUBSPOT_LIST_CONTACTS`, `mail.search`, `sendMail`).
 */
const wordsOf = (text: string): string =>
  text
    // `customer's` is one word, never `customer` and `s`.
    .replaceAll(/['’]/gu, "")
    .replaceAll(
      /(?<lower>[\p{Ll}\p{N}])(?<upper>\p{Lu})/gu,
      "$<lower> $<upper>"
    )
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A schema's JSON text as data, or `undefined` if it can't be read. */
const parsed = (text: string | null): unknown => {
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The properties an object schema names, by name. */
const propertiesOf = (schema: unknown): Record<string, unknown> => {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return {};
  }
  return schema.properties;
};

/** A description's first sentence on its first line, cut to a summary's length. */
const summaryOf = (description: string | null): string => {
  const line = description?.trim().split("\n")[0] ?? "";
  const [sentence = ""] = line.split(/(?<=[.!?])\s/u);
  return sentence.length > maxSummaryChars
    ? `${sentence.slice(0, maxSummaryChars - 1).trimEnd()}…`
    : sentence;
};

/** How a type is written: how deep, on lines of its own or not, and how much of it. */
interface TypeStyle {
  /** Levels of objects written out; deeper ones read `{…}`. */
  depth: number;
  multiline: boolean;
  /**
   * Schemas, and characters of names, values and notes, left to write,
   * shared by the whole type: past either, a schema reads `unknown` and
   * a member `…`. A vendor's schema is untrusted: a small one can nest a
   * type list in a type list, or hold long names and values, so the work
   * and the text stay bounded by these, whatever it holds.
   */
  left: { schemas: number; chars: number };
}

/** How much of a schema a match's one-line input type writes. */
const compact = { schemas: 40, chars: 400 };

/** How much of a schema a declaration writes, its input and output each. */
const declared = { schemas: 400, chars: 4000 };

/** Most characters of a tool's description a declaration writes. */
const maxDescriptionChars = 4000;

/** Most characters of a property's description a declaration writes. */
const maxPropertyNoteChars = 200;

/** Most values of an enum written out; one with more reads as its type. */
const maxEnumValues = 20;

/** Longest string written as a literal type; a longer one reads `string`. */
const maxLiteralChars = 100;

const identifierPattern = /^[A-Za-z_$][\w$]*$/u;

/** A property's name as TypeScript writes it. */
const keyOf = (name: string): string =>
  identifierPattern.test(name) ? name : JSON.stringify(name);

/** `text` safe inside a JSDoc comment, on one line, cut to `max`. */
const commentText = (text: string, max = Number.POSITIVE_INFINITY): string => {
  const cut = text.length > max ? `${text.slice(0, max)}…` : text;
  return cut.replaceAll("*/", "*\\/");
};

/** A member of a union or an array, bracketed where it must be. */
const bracketed = (type: string): string =>
  type.includes(" | ") ? `(${type})` : type;

/** A `const` or `enum` value as a literal type, or the type it is of. */
const literalOf = (value: unknown): string => {
  if (typeof value === "string") {
    return value.length > maxLiteralChars ? "string" : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value === null ? "null" : "unknown";
};

/**
 * A JSON Schema as a TypeScript type, as far as `style` writes it out:
 * what the chat's agent reads of a tool's input and output. Read only for
 * the words: nothing is checked by it, and what it can't tell reads
 * `unknown`.
 */
const typeOf = (schema: unknown, style: TypeStyle, indent = ""): string => {
  const { left } = style;
  if (!isRecord(schema) || left.schemas <= 0 || left.chars <= 0) {
    return "unknown";
  }
  left.schemas -= 1;
  // Its properties, or a record, or any object.
  const objectType = (): string => {
    const properties = Object.entries(propertiesOf(schema));
    if (properties.length === 0) {
      const values = schema.additionalProperties;
      if (values === false) {
        return "{}";
      }
      return isRecord(values)
        ? `Record<string, ${typeOf(values, style, indent)}>`
        : "Record<string, unknown>";
    }
    if (style.depth === 0) {
      return "{…}";
    }
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((name) => typeof name === "string")
        : []
    );
    const inner = { ...style, depth: style.depth - 1 };
    const deeper = `${indent}  `;
    const members: string[] = [];
    for (const [name, property] of properties) {
      const key = keyOf(name);
      const described =
        style.multiline &&
        isRecord(property) &&
        typeof property.description === "string"
          ? commentText(
              property.description
                .slice(0, maxPropertyNoteChars + 1)
                .trim()
                .replaceAll(/\s+/gu, " "),
              maxPropertyNoteChars
            )
          : "";
      // Each member is paid for, its name and note by their length: past
      // the budget, the rest read `…`.
      if (left.schemas <= 0 || key.length + described.length > left.chars) {
        members.push(`${style.multiline ? deeper : ""}…;`);
        break;
      }
      left.schemas -= 1;
      left.chars -= key.length + described.length;
      const optional = required.has(name) ? "" : "?";
      const member = `${key}${optional}: ${typeOf(property, inner, deeper)};`;
      members.push(
        described === ""
          ? `${style.multiline ? deeper : ""}${member}`
          : `${deeper}/** ${described} */\n${deeper}${member}`
      );
    }
    return style.multiline
      ? `{\n${members.join("\n")}\n${indent}}`
      : `{ ${members.join(" ").slice(0, -1)} }`;
  };
  // Its values, as literals, while they fit: else what type they are of.
  let values: unknown[] = [];
  if (Object.hasOwn(schema, "const")) {
    values = [schema.const];
  } else if (
    Array.isArray(schema.enum) &&
    schema.enum.length <= maxEnumValues
  ) {
    values = schema.enum;
  }
  const literals = [...new Set(values.map(literalOf))].join(" | ");
  if (literals !== "" && literals.length <= left.chars) {
    left.chars -= literals.length;
    return literals;
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    return [
      ...new Set(union.map((member) => typeOf(member, style, indent))),
    ].join(" | ");
  }
  // Each type once: a list that repeats one writes it once.
  const types = new Set<unknown>(
    Array.isArray(schema.type) ? schema.type : [schema.type]
  );
  const written = [...types].map((type) => {
    switch (type) {
      case "string":
      case "boolean":
      case "null": {
        return type;
      }
      case "number":
      case "integer": {
        return "number";
      }
      case "array": {
        return `${bracketed(typeOf(schema.items, style, indent))}[]`;
      }
      case "object": {
        return objectType();
      }
      case undefined: {
        return isRecord(schema.properties) ? objectType() : "unknown";
      }
      default: {
        return "unknown";
      }
    }
  });
  return written.length === 0 ? "unknown" : [...new Set(written)].join(" | ");
};

/** A schema's type on one line, its top level alone: a match's input. */
const compactTypeOf = (schema: unknown): string =>
  typeOf(schema, { depth: 1, multiline: false, left: { ...compact } });

/** A schema's whole type, on lines of their own: a declaration's. */
const declaredTypeOf = (schema: unknown): string =>
  typeOf(schema, {
    depth: maxTypeDepth,
    multiline: true,
    left: { ...declared },
  });

/**
 * A tool's full declaration, as `readApi` hands over an API's: what it
 * does, its class, and the exact call with its input's and output's types.
 */
export const declarationOf = (tool: SearchableTool): string => {
  const said = (tool.description ?? "").trim();
  const lines = [
    ...(said === "" ? [] : commentText(said, maxDescriptionChars).split("\n")),
    ...(said === "" ? [] : [""]),
    `Class: ${tool.toolClass}.`,
    ...(tool.ask
      ? [
          `This chat can't call it yet: ask for connection ${JSON.stringify(tool.connection)} with \`request\` first, then call it by the binding you asked for.`,
        ]
      : []),
  ];
  // A connection to ask for is called by the binding it is granted under.
  const name = tool.ask ? "string" : JSON.stringify(tool.connection);
  return [
    "/**",
    ...lines.map((line) => (line === "" ? " *" : ` * ${line}`)),
    " */",
    `call(name: ${name}, action: ${JSON.stringify(tool.action)}, input: ${declaredTypeOf(parsed(tool.input))}): Promise<{ output: ${declaredTypeOf(parsed(tool.output))} | null; pending: { id: string } | null }>;`,
  ].join("\n");
};

/** A match as the chat's code reads it. */
const matchOf = (tool: SearchableTool): ToolMatch => ({
  connection: tool.connection,
  action: tool.action,
  summary: summaryOf(tool.description),
  class: tool.toolClass,
  input: compactTypeOf(parsed(tool.input)),
  ...(tool.ask ? { ask: true as const } : {}),
});

/** For each query, the best of `tools` for it, ranked by BM25 over them alone. */
export const searchTools = async (
  tools: readonly SearchableTool[],
  queries: readonly string[]
): Promise<ToolSearchResult[]> => {
  const index = create({
    schema: {
      name: "string",
      tag: "string",
      description: "string",
      args: "string",
    } as const,
    components: { tokenizer: { stemming: true, stopWords: ignored } },
  });
  await insertMultiple(
    index,
    tools.map((tool, position) => ({
      id: String(position),
      name: wordsOf(tool.action),
      tag: wordsOf(tool.tag),
      description: wordsOf(tool.description ?? ""),
      args: wordsOf(Object.keys(propertiesOf(parsed(tool.input))).join(" ")),
    }))
  );
  return await Promise.all(
    queries.map(async (query) => {
      const term = wordsOf(query);
      // Orama answers every tool, unranked, for no words at all, and a
      // query of words as common as "the" alone has none.
      if (index.tokenizer.tokenize(term).length === 0) {
        return { query, matches: [], related: [] };
      }
      const found = await search(index, {
        term,
        properties: ["name", "tag", "description", "args"],
        boost,
        limit: maxMatches + maxRelated,
      });
      const hits = found.hits.flatMap(({ id }) => {
        const tool = tools[Number(id)];
        return tool === undefined ? [] : [tool];
      });
      return {
        query,
        matches: hits.slice(0, maxMatches).map(matchOf),
        related: hits.slice(maxMatches).map(({ connection, action, ask }) => ({
          connection,
          action,
          ...(ask ? { ask: true as const } : {}),
        })),
      };
    })
  );
};
