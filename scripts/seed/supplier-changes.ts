/**
 * The Supplier changes App (scripts/seed-supplier-changes.ts): a
 * manufacturer's letters from suppliers (a price rise, a change to a part),
 * read by Grasp, with what each touches worked out from the company's own
 * data: its articles, its products' parts lists in SAP, and the parts list
 * on each product's drawing. A person approves the message to customers.
 * It also checks each product: where the drawing the customer approves,
 * SAP and the price disagree.
 *
 * The model reads; the App's own code counts. Every price and every match
 * comes from the data, never from the model, so the same data always gives
 * the same answer.
 *
 * Written as an App's builder would, with the public SDK and
 * `@grasp-os/app-kit` only. Its demo data is made up; a company's own
 * exports import over it (`--data`), and stay on the machine.
 */
import type { DefinitionOperation } from "@grasp-os/runtime/definition";

export const appName = "Supplier changes";

export const appDescription =
  "Letters from suppliers, what they touch, and what they cost.";

/** The tables, in the order an import fills them. */
export const tables = [
  "articles",
  "assemblies",
  "bomLines",
  "drawingLines",
  "notices",
] as const;

export type TableName = (typeof tables)[number];

const members = { read: "appMembers", write: "appMembers" } as const;
const builders = { read: "appMembers", write: "appBuilders" } as const;

/** The App's definition: its tables, their indexes, and its use of AI. */
export const operations: DefinitionOperation[] = [
  {
    op: "addTable",
    name: "articles",
    fields: {
      number: "v.string().trim().min(1).max(40)",
      description: "v.string().max(500)",
      supplier: "v.string().max(200)",
      supplierPart: "v.string().max(100)",
      unit: "v.string().max(20)",
      stock: "v.number()",
      lastPurchasePrice: "v.number().nullable().default(null)",
      listPrice: "v.number().nullable().default(null)",
      active: "v.boolean().default(true)",
    },
    access: builders,
  },
  { op: "addIndex", table: "articles", name: "by_number", fields: ["number"] },
  {
    op: "addIndex",
    table: "articles",
    name: "by_supplier",
    fields: ["supplier"],
  },
  {
    op: "addTable",
    name: "assemblies",
    fields: {
      number: "v.string().trim().min(1).max(40)",
      name: "v.string().trim().min(1).max(200)",
      revision: "v.string().max(20)",
      customer: "v.string().max(200)",
      labourMinutes: "v.number().min(0)",
      labourRate: "v.number().min(0)",
      orderCost: "v.number().min(0)",
      margin: "v.number().min(0).max(0.9)",
      drawing: "v.string().max(300)",
    },
    access: builders,
  },
  {
    op: "addIndex",
    table: "assemblies",
    name: "by_number",
    fields: ["number"],
  },
  {
    op: "addTable",
    name: "bomLines",
    fields: {
      assembly: "v.string().max(40)",
      position: "v.number().integer().min(1)",
      article: "v.string().max(40)",
      quantity: "v.number().min(0)",
      unit: "v.string().max(20)",
    },
    access: builders,
  },
  {
    op: "addIndex",
    table: "bomLines",
    name: "by_assembly",
    fields: ["assembly", "position"],
  },
  {
    op: "addIndex",
    table: "bomLines",
    name: "by_article",
    fields: ["article"],
  },
  {
    op: "addTable",
    name: "drawingLines",
    fields: {
      assembly: "v.string().max(40)",
      position: "v.number().integer().min(1)",
      description: "v.string().max(500)",
      supplierPart: "v.string().max(100).nullable().default(null)",
      quantity: "v.number().min(0)",
      unit: "v.string().max(20)",
    },
    access: builders,
  },
  {
    op: "addIndex",
    table: "drawingLines",
    name: "by_assembly",
    fields: ["assembly", "position"],
  },
  {
    op: "addTable",
    name: "notices",
    fields: {
      supplier: "v.string().trim().min(1).max(200)",
      title: "v.string().trim().min(1).max(200)",
      received: "v.timestamp()",
      letter: "v.string().max(20000)",
      status:
        'v.enum(["new", "reading", "working", "writing", "read", "approved"]).default("new")',
      problem: "v.string().max(500).nullable().default(null)",
      kind: 'v.enum(["price", "change"]).nullable().default(null)',
      supplierName: "v.string().max(200).nullable().default(null)",
      summary: "v.string().max(600).nullable().default(null)",
      percent: "v.number().nullable().default(null)",
      effective: "v.string().max(80).nullable().default(null)",
      parts: "v.array(v.string().max(60)).max(200).default([])",
      message: "v.string().max(6000).nullable().default(null)",
      approvedBy: "v.string().max(200).nullable().default(null)",
      approvedAt: "v.timestamp().nullable().default(null)",
    },
    access: members,
  },
  {
    op: "addIndex",
    table: "notices",
    name: "by_received",
    fields: ["received"],
  },
  {
    op: "addPermission",
    permission: "permission.ai({ maxOutputTokens: 4000 })",
  },
];

/** How a product is priced, and how part numbers are matched: pure, so a test can hold it. */
const pricing = `/** The quantities a product's price is worked out for. */
export const quantities = [1, 10, 50, 100, 250];

/** How a product is costed beyond its parts. */
export interface Costing {
  readonly labourMinutes: number;
  readonly labourRate: number;
  readonly orderCost: number;
  readonly margin: number;
}

/** A cost with the product's margin on it, as a share of the price. */
export const withMargin = (cost: number, margin: number): number =>
  cost / (1 - margin);

/**
 * The price of one piece at each quantity: its parts with margin, its
 * labour, and the order's fixed cost spread over the pieces.
 */
export const pricesPerQuantity = (
  parts: number,
  costing: Costing
): { quantity: number; price: number }[] =>
  quantities.map((quantity) => ({
    quantity,
    price:
      withMargin(parts, costing.margin) +
      costing.labourMinutes * costing.labourRate +
      costing.orderCost / quantity,
  }));

const hash = /^#/u;

const normal = (part: string): string =>
  part.trim().toUpperCase().replace(hash, "");

/** What may follow a part number for a pack size: letters and digits, no hyphen. */
const packSize = /^[A-Z0-9]+$/u;

/** The part numbers a text names: runs of letters, digits and hyphens. */
const partNumbers = /[A-Z0-9][A-Z0-9-]*/gu;

/** Whether \`part\` is \`drawn\`, or it with a pack size after it (MPX17839B25 is MPX17839). */
const isPart = (drawn: string, part: string): boolean =>
  part === drawn ||
  (part.startsWith(drawn) && packSize.test(part.slice(drawn.length)));

/**
 * Whether a drawing's part number names the same part as SAP's: SAP's
 * part number, or one its description names, is it or it with a pack size
 * after it. A hyphen after it is another variant (NF-Y08 isn't
 * NF-Y08-PVDF), and so is more on the drawing's side (PFTC750PP isn't
 * PFTC750).
 */
export const samePart = (
  drawing: string,
  sap: string,
  description: string
): boolean => {
  const drawn = normal(drawing);
  if (drawn === "") {
    return true;
  }
  const named = description.toUpperCase().match(partNumbers) ?? [];
  return [normal(sap), ...named].some((part) => isPart(drawn, part));
};

/**
 * Whether a supplier's part number is one a letter lists: the same, or it
 * with more after a hyphen (a letter's Y0-8PP is SAP's Y0-8PP-QC).
 */
export const listedPart = (part: string, listed: readonly string[]): boolean => {
  const own = normal(part);
  return (
    own !== "" &&
    listed.some((item) => {
      const named = normal(item);
      return named !== "" && (own === named || own.startsWith([named, "-"].join("")));
    })
  );
};
`;

/** Reads a product, its parts and their prices: shared by both modules. */
const costing = `import type { Doc, QueryCtx } from "@server/_generated/server";

import { pricesPerQuantity } from "./pricing.ts";

/**
 * Records one read takes: well within its bounds, so a whole table is read
 * in a few reads however big it is, and a call stays within the host calls
 * it may make (one read per page, never one per record).
 */
const pageSize = 5000;

/** Every article, by number, a page at a time. */
export const everyArticle = async (
  ctx: QueryCtx,
  cursor: string | null = null,
  found: Map<string, Doc<"articles">> = new Map()
): Promise<Map<string, Doc<"articles">>> => {
  const page = await ctx.db
    .query("articles")
    .withIndex("by_number")
    .paginate({ pageSize, cursor, endCursor: null });
  for (const article of page.items) {
    found.set(article.number, article);
  }
  return page.hasMore ? await everyArticle(ctx, page.nextCursor, found) : found;
};

/** Every product, by number, a page at a time. */
export const everyAssembly = async (
  ctx: QueryCtx,
  cursor: string | null = null,
  found: Map<string, Doc<"assemblies">> = new Map()
): Promise<Map<string, Doc<"assemblies">>> => {
  const page = await ctx.db
    .query("assemblies")
    .withIndex("by_number")
    .paginate({ pageSize, cursor, endCursor: null });
  for (const assembly of page.items) {
    found.set(assembly.number, assembly);
  }
  return page.hasMore ? await everyAssembly(ctx, page.nextCursor, found) : found;
};

/** Every line of every product's parts list in SAP, a page at a time. */
export const everyBomLine = async (
  ctx: QueryCtx,
  cursor: string | null = null,
  found: Doc<"bomLines">[] = []
): Promise<Doc<"bomLines">[]> => {
  const page = await ctx.db
    .query("bomLines")
    .withIndex("by_assembly")
    .paginate({ pageSize, cursor, endCursor: null });
  const all = [...found, ...page.items];
  return page.hasMore ? await everyBomLine(ctx, page.nextCursor, all) : all;
};

/** Every line of every product's drawing, a page at a time. */
export const everyDrawingLine = async (
  ctx: QueryCtx,
  cursor: string | null = null,
  found: Doc<"drawingLines">[] = []
): Promise<Doc<"drawingLines">[]> => {
  const page = await ctx.db
    .query("drawingLines")
    .withIndex("by_assembly")
    .paginate({ pageSize, cursor, endCursor: null });
  const all = [...found, ...page.items];
  return page.hasMore ? await everyDrawingLine(ctx, page.nextCursor, all) : all;
};

/** A product by its number, or null. */
export const assemblyOf = async (
  ctx: QueryCtx,
  number: string
): Promise<Doc<"assemblies"> | null> =>
  await ctx.db
    .query("assemblies")
    .withIndex("by_number", (range) => range.eq("number", number))
    .first();

/** A line of a product's parts list in SAP, with its article. */
export interface SapLine {
  readonly line: Doc<"bomLines">;
  readonly article: Doc<"articles"> | null;
}

/** Lines in their order, each with its article. */
export const withArticles = (
  lines: readonly Doc<"bomLines">[],
  articles: ReadonlyMap<string, Doc<"articles">>
): SapLine[] =>
  lines
    .toSorted((a, b) => a.position - b.position)
    .map((line) => ({ line, article: articles.get(line.article) ?? null }));

/**
 * What one piece costs in parts, each line at the price \`priceOf\` gives
 * its article; a line with none counts nothing.
 */
export const partsCost = (
  lines: readonly SapLine[],
  priceOf: (article: Doc<"articles">) => number | null
): number => {
  let sum = 0;
  for (const { line, article } of lines) {
    const price = article === null ? null : priceOf(article);
    if (price !== null) {
      sum += line.quantity * price;
    }
  }
  return sum;
};

/** The price of one piece of \`assembly\` when ordered alone. */
export const singlePrice = (assembly: Doc<"assemblies">, parts: number): number =>
  pricesPerQuantity(parts, assembly)[0]?.price ?? 0;
`;

/** Compares a product's drawing with SAP, line by line: pure, so a test can hold it. */
const compare = `import type { Doc } from "@server/_generated/server";

import type { SapLine } from "./costing.ts";
import { samePart, withMargin } from "./pricing.ts";

/** What can be wrong with a line. */
export type Issue = "quantity" | "price" | "notOnDrawing" | "notInSap" | "part";

/** Where the drawing the customer approves, SAP and the price disagree. */
export interface Finding {
  readonly kind: Issue;
  readonly title: string;
  readonly detail: string;
  /** What it does to the price of one piece, margin included; null when unknown. */
  readonly effect: number | null;
  /** Whether the effect is worked out from an older price. */
  readonly estimate: boolean;
}

/** One position of the parts list: the drawing beside SAP. */
export interface Line {
  readonly position: number;
  readonly name: string;
  readonly article: string | null;
  readonly drawing: number | null;
  readonly sap: number | null;
  readonly unit: string;
  readonly price: number | null;
  readonly issue: Issue | null;
}

/** A position's lines on the drawing and in SAP, either missing. */
interface Pair {
  readonly position: number;
  readonly own: SapLine | undefined;
  readonly drawn: Doc<"drawingLines"> | undefined;
}

const words = (...parts: (string | number)[]): string => parts.join(" ");

/** The finding of a line on one side only, or with another quantity or part. */
const findingOf = (
  { position, own, drawn }: Pair,
  name: string,
  margin: number
): Finding | null => {
  const price = own?.article?.listPrice ?? null;
  if (own === undefined && drawn !== undefined) {
    return {
      kind: "notInSap",
      title: words(name, "is on the drawing, not in SAP"),
      detail: words("Position", position, "of the drawing."),
      effect: null,
      estimate: false,
    };
  }
  if (own === undefined || drawn === undefined) {
    return own === undefined
      ? null
      : {
          kind: "notOnDrawing",
          title: words(name, "is in SAP and in the price, not on the drawing"),
          detail: words("Position", position, "in SAP:", own.line.quantity, own.line.unit),
          effect: price === null ? null : -withMargin(own.line.quantity * price, margin),
          estimate: false,
        };
  }
  if (own.line.quantity !== drawn.quantity) {
    return {
      kind: "quantity",
      title: words(name, "· the drawing says", drawn.quantity, "but SAP and the price count", own.line.quantity),
      detail: "The customer approves the drawing, so the product is built as drawn.",
      effect:
        price === null
          ? null
          : withMargin((drawn.quantity - own.line.quantity) * price, margin),
      estimate: false,
    };
  }
  const article = own.article;
  if (
    article === null ||
    drawn.supplierPart === null ||
    samePart(drawn.supplierPart, article.supplierPart, article.description)
  ) {
    return null;
  }
  return {
    kind: "part",
    title: words(name, "· the drawing names", drawn.supplierPart, "but SAP has", article.supplierPart),
    detail: words("Position", position),
    effect: null,
    estimate: false,
  };
};

/** The finding of the lines SAP has no price for: what the price leaves out. */
const unpricedOf = (lines: readonly SapLine[], margin: number): Finding | null => {
  const unpriced = lines.filter(({ article }) => article?.listPrice === null);
  if (unpriced.length === 0) {
    return null;
  }
  let estimate = 0;
  let known = false;
  for (const { line, article } of unpriced) {
    const last = article?.lastPurchasePrice ?? null;
    if (last !== null) {
      estimate += line.quantity * last;
      known = true;
    }
  }
  return {
    kind: "price",
    title: words(
      unpriced.length,
      unpriced.length === 1 ? "part has" : "parts have",
      "no price in the price list, so the price leaves them out"
    ),
    detail: unpriced
      .map(({ line, article }) => article?.description ?? line.article)
      .join(" · "),
    effect: known ? withMargin(estimate, margin) : null,
    estimate: true,
  };
};

/** What a position is called: as the drawing names it, else SAP. */
const nameOf = ({ own, drawn }: Pair): string =>
  drawn?.description ?? own?.article?.description ?? own?.line.article ?? "";

/** A position as the parts list shows it, with what is wrong with it. */
const lineOf = (
  { position, own, drawn }: Pair,
  name: string,
  finding: Finding | null
): Line => {
  const price = own?.article?.listPrice ?? null;
  const unpriced = own !== undefined && price === null ? "price" : null;
  return {
    position,
    name,
    article: own?.line.article ?? null,
    drawing: drawn?.quantity ?? null,
    sap: own?.line.quantity ?? null,
    unit: own?.line.unit ?? drawn?.unit ?? "",
    price,
    issue: finding?.kind ?? unpriced,
  };
};

/**
 * Each position of the drawing beside SAP, and the findings: lines on one
 * side only, another quantity or part number, and lines without a price.
 */
export const compare = (
  sap: readonly SapLine[],
  drawing: readonly Doc<"drawingLines">[],
  margin: number
): { lines: Line[]; findings: Finding[] } => {
  const positions = [
    ...new Set([...sap.map(({ line }) => line.position), ...drawing.map((line) => line.position)]),
  ].toSorted((a, b) => a - b);
  const lines: Line[] = [];
  const findings: Finding[] = [];
  for (const position of positions) {
    const pair: Pair = {
      position,
      own: sap.find(({ line }) => line.position === position),
      drawn: drawing.find((line) => line.position === position),
    };
    const name = nameOf(pair);
    const finding = findingOf(pair, name, margin);
    if (finding !== null) {
      findings.push(finding);
    }
    lines.push(lineOf(pair, name, finding));
  }
  const unpriced = unpricedOf(sap, margin);
  const all = unpriced === null ? findings : [...findings, unpriced];
  // What does most to the price first; those it does nothing known to, last.
  return {
    lines,
    findings: all.toSorted((x, y) => Math.abs(y.effect ?? 0) - Math.abs(x.effect ?? 0)),
  };
};
`;

const products = `import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import { doc, query } from "@server/_generated/server";

import { compare } from "./compare.ts";
import { assemblyOf, everyArticle, partsCost, withArticles } from "./costing.ts";
import { pricesPerQuantity, withMargin } from "./pricing.ts";

export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("assemblies")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("assemblies")
      .withIndex("by_number")
      .paginate(args.pagination),
});

/** A product checked: its drawing beside SAP, what disagrees, and its price. */
export const check = query({
  args: { number: v.string().trim().min(1).max(40) },
  handler: async (ctx, args) => {
    const assembly = await assemblyOf(ctx, args.number);
    if (assembly === null) {
      return null;
    }
    const own = await ctx.db
      .query("bomLines")
      .withIndex("by_assembly", (range) => range.eq("assembly", assembly.number))
      .collect();
    const sap = withArticles(own, await everyArticle(ctx));
    const drawing = await ctx.db
      .query("drawingLines")
      .withIndex("by_assembly", (range) => range.eq("assembly", assembly.number))
      .collect();
    const parts = partsCost(sap, (article) => article.listPrice);
    return {
      assembly,
      ...compare(sap, drawing, assembly.margin),
      parts: withMargin(parts, assembly.margin),
      labour: assembly.labourMinutes * assembly.labourRate,
      prices: pricesPerQuantity(parts, assembly),
    };
  },
});
`;

const notices = `import {
  AppError,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import {
  action,
  doc,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "@server/_generated/server";
import type { ActionCtx, Doc } from "@server/_generated/server";

import { compare } from "./compare.ts";
import type { SapLine } from "./costing.ts";
import {
  everyArticle,
  everyAssembly,
  everyBomLine,
  everyDrawingLine,
  partsCost,
  singlePrice,
  withArticles,
} from "./costing.ts";
import { listedPart } from "./pricing.ts";

/** What Grasp reads in a letter. */
const reading = v.object({
  supplier: v.string().max(200),
  kind: v.enum(["price", "change"]),
  summary: v.string().max(600),
  percent: v.number().nullable(),
  effective: v.string().max(80).nullable(),
  parts: v.array(v.string().max(60)).max(200),
});

const readingInstructions = [
  "You read a letter a supplier sent to a manufacturer and say what it says, exactly as the letter says it.",
  "supplier: which of the listed suppliers sent it, written exactly as listed; an empty text when none of them did.",
  "kind: price when it changes prices; change when it changes a product, its drawing, material or process.",
  "summary: one plain sentence: what changes, for which products, from when.",
  "percent: the price change in percent (4 for 4%), or null when it changes no price.",
  "effective: the date it takes effect, as the letter writes it, or null when it gives none.",
  "parts: every part number the letter lists, exactly as written; none when it applies to all of the supplier's products.",
].join("\\n");

const messageInstructions = [
  "Write the email a manufacturer sends its customers about a change from one of its suppliers.",
  "Use only the facts given: the supplier's letter and the products it touches. Plain, friendly English, at most 140 words, no subject line.",
  "Say what changes and from when. For a price change, give each product's new price for one piece, as given.",
  "For a change to a part, say which products use it, and what the supplier's letter says it does to fit, form and function.",
  "When no product uses the parts it changes, write instead a short note to the quality team, starting 'Quality team,': which parts and articles it names, that no product in the parts lists uses them, and that no customer needs a message.",
  "Start with 'Dear customer,' and end with 'Kind regards,'.",
].join("\\n");

/** How many findings a product's check has, and what the known ones do to its price. */
const checkOf = (
  sap: readonly SapLine[],
  drawing: readonly Doc<"drawingLines">[],
  margin: number
): { findings: number; effect: number } => {
  const { findings } = compare(sap, drawing, margin);
  let effect = 0;
  for (const finding of findings) {
    effect += finding.effect ?? 0;
  }
  return { findings: findings.length, effect };
};

/** Suppliers read from the articles per page: within one read's bounds. */
const supplierPageSize = 5000;

export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notices")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("notices")
      .withIndex("by_received")
      .order("desc")
      .paginate(args.pagination),
});

export const get = query({
  args: { id: v.id("notices") },
  returns: doc("notices").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notices", args.id),
});

/** The suppliers one page of the articles names, as SAP names them. */
export const supplierPage = internalQuery({
  args: { pagination: paginationOptionsValidator },
  returns: v.object({
    suppliers: v.array(v.string()).max(supplierPageSize),
    next: v.string().nullable(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("articles")
      .withIndex("by_supplier")
      .paginate(args.pagination);
    return {
      suppliers: [...new Set(page.items.map(({ supplier }) => supplier))],
      next: page.hasMore ? page.nextCursor : null,
    };
  },
});

/** Every supplier the articles name, page by page, however many articles. */
const suppliersOf = async (
  ctx: ActionCtx,
  cursor: string | null = null,
  found: ReadonlySet<string> = new Set()
): Promise<string[]> => {
  const page = await ctx.runQuery(supplierPage, {
    pagination: { pageSize: supplierPageSize, cursor },
  });
  const all = new Set([...found, ...page.suppliers]);
  return page.next === null
    ? [...all].filter((supplier) => supplier !== "")
    : await suppliersOf(ctx, page.next, all);
};

/** What a letter Grasp read touches: its articles, and the products using them. */
export const impact = query({
  args: { id: v.id("notices") },
  handler: async (ctx, args) => {
    const notice = await ctx.db.get("notices", args.id);
    if (notice === null || notice.kind === null || notice.supplierName === null) {
      return null;
    }
    const { parts, supplierName } = notice;
    const [articles, assemblies, lines, drawings] = await Promise.all([
      everyArticle(ctx),
      everyAssembly(ctx),
      everyBomLine(ctx),
      everyDrawingLine(ctx),
    ]);
    const own = [...articles.values()].filter((article) => article.supplier === supplierName);
    // The parts it lists, for either kind; all of the supplier's without any.
    const affected =
      parts.length === 0
        ? own
        : own.filter((article) => listedPart(article.supplierPart, parts));
    const raise = notice.kind === "price" ? 1 + (notice.percent ?? 0) / 100 : 1;
    const touched = new Map(affected.map((article) => [article.number, article]));
    const byAssembly = new Map<string, Doc<"bomLines">[]>();
    for (const line of lines) {
      byAssembly.set(line.assembly, [...(byAssembly.get(line.assembly) ?? []), line]);
    }
    const products = [];
    for (const [number, productLines] of byAssembly) {
      const assembly = assemblies.get(number);
      const used = productLines.filter((line) => touched.has(line.article));
      if (assembly === undefined || used.length === 0) {
        continue;
      }
      const sap = withArticles(productLines, articles);
      const before = partsCost(sap, (article) => article.listPrice);
      const after = partsCost(sap, (article) => {
        if (article.listPrice === null) {
          return null;
        }
        return touched.has(article.number) ? article.listPrice * raise : article.listPrice;
      });
      products.push({
        number,
        name: assembly.name,
        revision: assembly.revision,
        customer: assembly.customer,
        uses: used.map((line) => ({
          article: line.article,
          description: touched.get(line.article)?.description ?? line.article,
          quantity: line.quantity,
        })),
        now: singlePrice(assembly, before),
        after: singlePrice(assembly, after),
        // Each product it touches checked too: what its drawing, SAP and price disagree on.
        ...checkOf(
          sap,
          drawings.filter((line) => line.assembly === number),
          assembly.margin
        ),
      });
    }
    return {
      count: affected.length,
      inStock: affected.filter((article) => article.stock > 0).length,
      articles: affected
        .toSorted((a, b) => b.stock - a.stock)
        .map((article) => {
          // The price list's price, else what it was last bought for (SAP's 0: never).
          const last = article.lastPurchasePrice === 0 ? null : article.lastPurchasePrice;
          const price = article.listPrice ?? last;
          return {
            number: article.number,
            description: article.description,
            supplierPart: article.supplierPart,
            stock: article.stock,
            price,
            newPrice: price === null ? null : price * raise,
          };
        }),
      products,
    };
  },
});

/**
 * Claims a letter for the next step, in one transaction: reading one that
 * is new, or writing to customers about one Grasp just worked out. Anyone
 * else at it already is refused, so a letter is never read twice at once.
 */
export const begin = internalMutation({
  args: { id: v.id("notices"), step: v.enum(["reading", "writing"]) },
  returns: doc("notices"),
  handler: async (ctx, args) => {
    const notice = await ctx.db.get("notices", args.id);
    if (notice === null) {
      throw new AppError("notice.not_found", "This letter is gone.");
    }
    const from = args.step === "reading" ? "new" : "working";
    if (notice.status !== from) {
      throw new AppError("notice.busy", "Grasp is at this letter already.");
    }
    await ctx.db.patch("notices", args.id, { status: args.step, problem: null });
    return { ...notice, status: args.step, problem: null };
  },
});

/** Puts a letter back as new with what went wrong, unless someone moved it on since. */
export const stop = internalMutation({
  args: {
    id: v.id("notices"),
    step: v.enum(["reading", "writing"]),
    problem: v.string().max(500),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const notice = await ctx.db.get("notices", args.id);
    if (notice?.status === args.step) {
      await ctx.db.patch("notices", args.id, { status: "new", problem: args.problem });
    }
    return null;
  },
});

export const saveReading = internalMutation({
  args: {
    id: v.id("notices"),
    reading,
    supplierName: v.string().max(200),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const notice = await ctx.db.get("notices", args.id);
    if (notice?.status !== "reading") {
      throw new AppError("notice.moved", "The letter was started over.");
    }
    await ctx.db.patch("notices", args.id, {
      status: "working",
      kind: args.reading.kind,
      summary: args.reading.summary,
      percent: args.reading.percent,
      effective: args.reading.effective,
      parts: args.reading.parts,
      supplierName: args.supplierName,
    });
    return null;
  },
});

export const saveMessage = internalMutation({
  args: { id: v.id("notices"), message: v.string().max(6000) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const notice = await ctx.db.get("notices", args.id);
    if (notice?.status !== "writing") {
      throw new AppError("notice.moved", "The letter was started over.");
    }
    await ctx.db.patch("notices", args.id, { message: args.message, status: "read" });
    return null;
  },
});

/** A letter someone hands to Grasp, received now. */
export const add = mutation({
  args: {
    supplier: v.string().trim().min(1).max(200),
    title: v.string().trim().min(1).max(200),
    letter: v.string().trim().min(1).max(20000),
  },
  returns: v.id("notices"),
  handler: async (ctx, args) =>
    await ctx.db.insert("notices", { ...args, received: Date.now() }),
});

const euros = (value: number): string => ["EUR", value.toFixed(2)].join(" ");

const problemOf = (error: unknown): string =>
  (error instanceof Error ? error.message : "Something went wrong.").slice(0, 500);

/** The facts the message to customers is written from: the letter and what it touches. */
const factsOf = (
  letter: string,
  found: {
    products: { name: string; number: string; customer: string; now: number; after: number }[];
  } | null
): string => {
  const products = found?.products ?? [];
  return [
    "The supplier's letter:",
    letter,
    "",
    products.length === 0
      ? "No product in the parts lists uses the parts it changes."
      : "Products it touches:",
    ...products.map((product) =>
      [
        "-",
        product.name,
        ["(", product.number, ")"].join(""),
        "for",
        [product.customer, ":"].join(""),
        "price for one piece now",
        euros(product.now),
        "and from then on",
        euros(product.after),
      ].join(" ")
    ),
  ].join("\\n");
};

/**
 * Step one: reads the letter, what it changes, from which of the
 * articles' suppliers and from when. Answers whether it read it; a letter
 * it couldn't read goes back to new, saying why.
 */
export const read = action({
  args: { id: v.id("notices") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const notice = await ctx.runMutation(begin, { id: args.id, step: "reading" });
    try {
      const known = await suppliersOf(ctx);
      const answer = await ctx.ai.generate({
        instructions: readingInstructions,
        prompt: ["Suppliers:", ...known, "", "The letter:", notice.letter].join("\\n"),
        output: reading,
      });
      if (!known.includes(answer.supplier)) {
        await ctx.runMutation(stop, {
          id: args.id,
          step: "reading",
          problem: [notice.supplier, "isn't among the suppliers of the articles in SAP."].join(" "),
        });
        return false;
      }
      await ctx.runMutation(saveReading, {
        id: args.id,
        reading: answer,
        supplierName: answer.supplier,
      });
      return true;
    } catch (error) {
      await ctx.runMutation(stop, { id: args.id, step: "reading", problem: problemOf(error) });
      throw error;
    }
  },
});

/** Step two: writes the message to customers from what the letter touches. */
export const write = action({
  args: { id: v.id("notices") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const notice = await ctx.runMutation(begin, { id: args.id, step: "writing" });
    try {
      const found = await ctx.runQuery(impact, { id: args.id });
      const message = await ctx.ai.generate({
        instructions: messageInstructions,
        prompt: factsOf(notice.letter, found),
      });
      await ctx.runMutation(saveMessage, { id: args.id, message });
    } catch (error) {
      await ctx.runMutation(stop, { id: args.id, step: "writing", problem: problemOf(error) });
      throw error;
    }
    return null;
  },
});

export const approve = mutation({
  args: { id: v.id("notices"), message: v.string().trim().min(1).max(6000) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const notice = await ctx.db.get("notices", args.id);
    if (notice === null) {
      throw new AppError("notice.not_found", "This letter is gone.");
    }
    if (notice.status !== "read") {
      throw new AppError("notice.not_read", "Grasp reads the letter first.");
    }
    const user = await ctx.auth.getUser();
    // The approver's name as it was then: a record of who, not a reference.
    await ctx.db.patch("notices", args.id, {
      status: "approved",
      message: args.message,
      approvedBy: user.name,
      approvedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Puts a letter back as it came in, unread, wherever it is: for the App's
 * builders, and how a letter whose reading was cut off gets going again.
 */
export const startOver = mutation({
  args: { id: v.id("notices") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUser();
    if (!user.roles.includes("builder")) {
      throw new AppError("notice.builders_only", "Only the App's builders start a letter over.");
    }
    await ctx.db.patch("notices", args.id, {
      status: "new",
      kind: null,
      supplierName: null,
      summary: null,
      percent: null,
      effective: null,
      parts: [],
      message: null,
      approvedBy: null,
      approvedAt: null,
      problem: null,
    });
    return null;
  },
});
`;

const format = `const euros = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "EUR",
});

const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

const days = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** An amount in euros. */
export const money = (value: number): string => euros.format(value);

/** A difference in euros, with its sign: +€0.28, −€3.72. */
export const change = (value: number): string => {
  if (value > 0) {
    return ["+", euros.format(value)].join("");
  }
  if (value < 0) {
    return ["−", euros.format(-value)].join("");
  }
  return euros.format(0);
};

/** A number, as the reader writes it. */
export const amount = (value: number): string => numbers.format(value);

/** A day. */
export const day = (moment: number): string => days.format(moment);
`;

const figure = `import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/app-kit/components/card";
import { Stat } from "@grasp-os/app-kit/components/stat";

/** A key figure: what it is, its value, and a word under it. */
export const Figure = ({
  label,
  value,
  note,
  attention = false,
}: {
  label: string;
  value: string;
  note?: string;
  attention?: boolean;
}) => (
  <Card size="sm">
    <CardHeader>
      <CardDescription>{label}</CardDescription>
      <CardTitle>
        <Stat variant={attention ? "attention" : "default"}>{value}</Stat>
      </CardTitle>
    </CardHeader>
    {note === undefined ? null : (
      <CardContent>
        <CardDescription>{note}</CardDescription>
      </CardContent>
    )}
  </Card>
);
`;

const home = `import { useAction, useMutation, usePaginatedQuery } from "@grasp-os/sdk/react";
import { Badge } from "@grasp-os/app-kit/components/badge";
import { Button } from "@grasp-os/app-kit/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/app-kit/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/app-kit/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/app-kit/components/empty";
import { Field, FieldGroup, FieldLabel } from "@grasp-os/app-kit/components/field";
import { Grid } from "@grasp-os/app-kit/components/grid";
import { Input } from "@grasp-os/app-kit/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/app-kit/components/item";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/app-kit/components/page-header";
import { Skeleton } from "@grasp-os/app-kit/components/skeleton";
import { Spinner } from "@grasp-os/app-kit/components/spinner";
import { Textarea } from "@grasp-os/app-kit/components/textarea";
import { api } from "@server/_generated/api";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { day } from "../lib/format";
import { handOver } from "../lib/hand-over";
import { statuses } from "../lib/statuses";

/** How every letter goes, the same way each time. */
const steps = [
  { title: "A letter comes in", detail: "A price change, or a change to a part." },
  { title: "Grasp reads it", detail: "Who sent it, what changes, from when, which parts." },
  { title: "Grasp works out what it touches", detail: "Articles, products and new prices, from SAP." },
  { title: "You approve", detail: "The message to customers, written and ready." },
] as const;

const HowItRuns = () => (
  <Grid columns={4}>
    {steps.map((step, index) => (
      <Card key={step.title} size="sm">
        <CardHeader>
          <CardDescription>{["Step", String(index + 1)].join(" ")}</CardDescription>
          <CardTitle>{step.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription>{step.detail}</CardDescription>
        </CardContent>
      </Card>
    ))}
  </Grid>
);

const AddLetter = () => {
  const add = useMutation(api.notices.add);
  const read = useAction(api.notices.read);
  const write = useAction(api.notices.write);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [title, setTitle] = useState("");
  const [letter, setLetter] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = supplier.trim() !== "" && title.trim() !== "" && letter.trim() !== "";
  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const id = await add({ supplier, title, letter });
      // Grasp takes it from here; the letter's page follows each step live,
      // and keeps what went wrong if a step fails.
      void handOver(read, write, id);
      setOpen(false);
      await navigate({ to: "/letters/$noticeId", params: { noticeId: id } });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The letter wasn't added.");
    }
    setBusy(false);
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button variant="highlight" />}>Add a letter</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a letter</DialogTitle>
          <DialogDescription>Paste what the supplier sent. Grasp does the rest.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="supplier">Supplier</FieldLabel>
            <Input id="supplier" onChange={(event) => setSupplier(event.target.value)} value={supplier} />
          </Field>
          <Field>
            <FieldLabel htmlFor="title">Subject</FieldLabel>
            <Input id="title" onChange={(event) => setTitle(event.target.value)} value={title} />
          </Field>
          <Field>
            <FieldLabel htmlFor="letter">Letter</FieldLabel>
            <Textarea id="letter" onChange={(event) => setLetter(event.target.value)} rows={10} value={letter} />
          </Field>
        </FieldGroup>
        <DialogFooter>
          {failure === null ? null : <span>{failure}</span>}
          <Button disabled={!ready || busy} onClick={submit} variant="highlight">
            {busy ? <Spinner /> : null}
            Hand it to Grasp
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Records a list shows first, and more by. */
const pageSize = 20;

const Letters = () => {
  const { items: notices, hasMore, isLoading, loadMore } = usePaginatedQuery(
    api.notices.list,
    {},
    { initialPageSize: pageSize }
  );
  if (isLoading && notices.length === 0) {
    return <Skeleton className="h-24" />;
  }
  if (notices.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No letters yet</EmptyTitle>
          <EmptyDescription>Add the next one a supplier sends.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup spacing="tight">
      {notices.map((notice) => (
        <Item
          key={notice._id}
          render={<Link params={{ noticeId: notice._id }} to="/letters/$noticeId" />}
          variant="outline"
        >
          <ItemContent>
            <ItemTitle>{[notice.supplier, notice.title].join(" · ")}</ItemTitle>
            <ItemDescription>
              {notice.summary ?? ["Received", day(notice.received)].join(" ")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Badge variant={statuses[notice.status].variant}>
              {statuses[notice.status].busy ? <Spinner /> : null}
              {statuses[notice.status].label}
            </Badge>
          </ItemActions>
        </Item>
      ))}
      {hasMore ? <More onClick={() => loadMore(pageSize)} /> : null}
    </ItemGroup>
  );
};

const More = ({ onClick }: { onClick: () => void }) => (
  <Button onClick={onClick} variant="ghost">
    Show more
  </Button>
);

const Products = () => {
  const { items: assemblies, hasMore, isLoading, loadMore } = usePaginatedQuery(
    api.products.list,
    {},
    { initialPageSize: pageSize }
  );
  if (isLoading && assemblies.length === 0) {
    return <Skeleton className="h-24" />;
  }
  return (
    <ItemGroup spacing="tight">
      {assemblies.map((assembly) => (
        <Item
          key={assembly._id}
          render={<Link params={{ number: assembly.number }} to="/products/$number" />}
          variant="outline"
        >
          <ItemContent>
            <ItemTitle>{assembly.name}</ItemTitle>
            <ItemDescription>
              {[assembly.number, ["REV", assembly.revision].join(" "), assembly.customer].join(" · ")}
            </ItemDescription>
          </ItemContent>
        </Item>
      ))}
      {hasMore ? <More onClick={() => loadMore(pageSize)} /> : null}
    </ItemGroup>
  );
};

const Home = () => (
  <main className="flex flex-col gap-6 p-6">
    <PageHeader>
      <PageHeaderContent>
        <PageHeaderTitle>Supplier changes</PageHeaderTitle>
        <PageHeaderDescription>
          Every letter from a supplier, read and worked out the same way. You only approve.
        </PageHeaderDescription>
      </PageHeaderContent>
    </PageHeader>
    <HowItRuns />
    <Card>
      <CardHeader>
        <CardTitle>Letters</CardTitle>
        <CardDescription>From suppliers, newest first.</CardDescription>
        <CardAction>
          <AddLetter />
        </CardAction>
      </CardHeader>
      <CardContent>
        <Letters />
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>Products</CardTitle>
        <CardDescription>
          Checked against their drawing, SAP and the price list, again whenever one changes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Products />
      </CardContent>
    </Card>
  </main>
);

export const Route = createFileRoute("/")({ component: Home });
`;

/** Hands a letter to Grasp: both steps, one after the other. */
const handOverFile = `import type { Id } from "@server/_generated/dataModel";

type Step<Answer> = (args: { id: Id<"notices"> }) => Promise<Answer>;

/**
 * Reads the letter, then writes to customers about it. A step that fails
 * leaves its reason on the letter (\`problem\`), where its page shows it.
 */
export const handOver = async (
  read: Step<boolean>,
  write: Step<null>,
  id: Id<"notices">
): Promise<void> => {
  try {
    if (await read({ id })) {
      await write({ id });
    }
  } catch {
    // Kept on the letter.
  }
};
`;

/** How a letter's status shows. */
const statusesFile = `/** How each status of a letter shows: its words, its colour, and whether Grasp is at it. */
export const statuses = {
  new: { label: "Not read yet", variant: "default", busy: false },
  reading: { label: "Grasp is reading", variant: "default", busy: true },
  working: { label: "Grasp is working it out", variant: "default", busy: true },
  writing: { label: "Grasp is writing", variant: "default", busy: true },
  read: { label: "Waiting for you", variant: "attention", busy: false },
  approved: { label: "Approved", variant: "passed", busy: false },
} as const;
`;

const letter = `import { useAction, useMutation, useQuery, useUser } from "@grasp-os/sdk/react";
import type { FunctionReturn } from "@grasp-os/sdk";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/app-kit/components/alert";
import { Badge } from "@grasp-os/app-kit/components/badge";
import { Button } from "@grasp-os/app-kit/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/app-kit/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/app-kit/components/empty";
import { Grid } from "@grasp-os/app-kit/components/grid";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/app-kit/components/page-header";
import { Skeleton } from "@grasp-os/app-kit/components/skeleton";
import { Spinner } from "@grasp-os/app-kit/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/app-kit/components/table";
import { Textarea } from "@grasp-os/app-kit/components/textarea";
import {
  Trace,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/app-kit/components/trace";
import { api } from "@server/_generated/api";
import type { Doc, Id } from "@server/_generated/dataModel";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckIcon, CircleIcon, LoaderIcon, UserIcon } from "lucide-react";
import { useState } from "react";

import { Figure } from "../components/figure";
import { amount, change, day, money } from "../lib/format";
import { handOver } from "../lib/hand-over";
import { statuses } from "../lib/statuses";

type Notice = Doc<"notices">;
type Impact = NonNullable<FunctionReturn<typeof api.notices.impact>>;

/** Articles shown before the person asks for all. */
const firstArticles = 8;

/** The statuses a letter goes through, in order. */
const order = ["new", "reading", "working", "writing", "read", "approved"] as const;

const failureOf = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const percentOf = (notice: Notice): string =>
  notice.percent === null
    ? "Price change"
    : [notice.percent > 0 ? "+" : "", amount(notice.percent), "%"].join("");

/** One step of the letter: done, at work, or still to come. */
const Step = ({
  at,
  step,
  done,
  doing,
  detail,
}: {
  at: number;
  step: number;
  done: string;
  doing: string;
  detail?: string;
}) => {
  if (at > step) {
    return (
      <TraceLine wrap>
        <TraceIcon>
          <CheckIcon />
        </TraceIcon>
        <TraceTitle>{done}</TraceTitle>
        {detail === undefined ? null : <TraceDescription>{detail}</TraceDescription>}
      </TraceLine>
    );
  }
  return (
    <TraceLine status={at === step ? "running" : "pending"} wrap>
      <TraceIcon>{at === step ? <LoaderIcon /> : <CircleIcon />}</TraceIcon>
      <TraceTitle>{at === step ? doing : done}</TraceTitle>
    </TraceLine>
  );
};

/** What Grasp did with the letter, step by step, as it happens. */
const Steps = ({ notice, impact }: { notice: Notice; impact: Impact | null | undefined }) => {
  const at = order.indexOf(notice.status);
  const approved = notice.status === "approved";
  return (
    <Card>
      <CardHeader>
        <CardTitle>What Grasp did</CardTitle>
        <CardDescription>The same steps for every letter.</CardDescription>
      </CardHeader>
      <CardContent>
        <Trace>
          <Step at={1} detail={day(notice.received)} doing="" done="Letter received" step={0} />
          <Step
            at={at}
            detail={notice.supplierName ?? undefined}
            doing="Reading the letter"
            done="Read the letter"
            step={1}
          />
          <Step
            at={at}
            detail={
              impact === null || impact === undefined
                ? undefined
                : [amount(impact.count), "articles ·", amount(impact.products.length), impact.products.length === 1 ? "product" : "products"].join(" ")
            }
            doing="Working out what it touches in SAP"
            done="Worked out what it touches in SAP"
            step={2}
          />
          {impact !== null && impact !== undefined && impact.products.length === 0 ? (
            <Step at={at} doing="Writing a note for Quality" done="Wrote a note for Quality" step={3} />
          ) : (
            <Step at={at} doing="Writing the message to customers" done="Wrote the message to customers" step={3} />
          )}
          {at < 4 ? (
            <TraceLine status="pending" wrap>
              <TraceIcon>
                <CircleIcon />
              </TraceIcon>
              <TraceTitle>Your approval</TraceTitle>
            </TraceLine>
          ) : (
            <TraceLine status={approved ? undefined : "attention"} wrap>
              <TraceIcon>{approved ? <CheckIcon /> : <UserIcon />}</TraceIcon>
              <TraceTitle>
                {approved ? ["Approved by", notice.approvedBy ?? ""].join(" ") : "Waiting for your approval"}
              </TraceTitle>
              {approved && notice.approvedAt !== null ? (
                <TraceDescription>{day(notice.approvedAt)}</TraceDescription>
              ) : null}
            </TraceLine>
          )}
        </Trace>
      </CardContent>
    </Card>
  );
};

const WhatItSays = ({ notice }: { notice: Notice }) => (
  <Card>
    <CardHeader>
      <CardTitle>What the letter says</CardTitle>
      <CardDescription>{notice.summary ?? "Grasp is reading it."}</CardDescription>
    </CardHeader>
    <CardContent>
      {notice.kind === null ? (
        <Skeleton className="h-32" />
      ) : (
        <Table>
          <TableBody>
            <TableRow>
              <TableHead>Supplier in SAP</TableHead>
              <TableCell>{notice.supplierName ?? "Not found among the articles"}</TableCell>
            </TableRow>
            <TableRow>
              <TableHead>Change</TableHead>
              <TableCell>{notice.kind === "price" ? percentOf(notice) : "Change to a part"}</TableCell>
            </TableRow>
            <TableRow>
              <TableHead>From</TableHead>
              <TableCell>{notice.effective ?? "Not given"}</TableCell>
            </TableRow>
            <TableRow>
              <TableHead>Parts</TableHead>
              <TableCell>
                {notice.parts.length === 0 ? (
                  "Every article of the supplier"
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {notice.parts.map((part) => (
                      <Badge key={part} variant="outline">
                        {part}
                      </Badge>
                    ))}
                  </span>
                )}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </CardContent>
  </Card>
);

/** What Grasp found in the products it checked on the way. */
const AlsoFound = ({ impact }: { impact: Impact }) => {
  const flagged = impact.products.filter((product) => product.findings > 0);
  if (flagged.length === 0) {
    return null;
  }
  let findings = 0;
  let effect = 0;
  for (const product of flagged) {
    findings += product.findings;
    effect += product.effect;
  }
  const [first] = flagged;
  return (
    <Alert variant="attention">
      <AlertTitle>
        {[
          "Grasp also checked",
          flagged.length === 1 && first !== undefined ? first.name : [amount(flagged.length), "products"].join(" "),
          "and found",
          amount(findings),
          findings === 1 ? "thing" : "things",
          "that don't match",
        ].join(" ")}
      </AlertTitle>
      <AlertDescription>
        {effect > 0
          ? ["Its price leaves out about", money(effect), "a piece: more than this letter changes."].join(" ")
          : "The drawing the customer approves, SAP and the price disagree."}
      </AlertDescription>
      {first === undefined ? null : (
        <AlertAction>
          <Button render={<Link params={{ number: first.number }} to="/products/$number" />} variant="outline">
            See what
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
};

const ProductsTouched = ({ notice, impact }: { notice: Notice; impact: Impact }) => (
  <Card>
    <CardHeader>
      <CardTitle>
        {notice.kind === "price" ? "Products whose price changes" : "Products using these parts"}
      </CardTitle>
      <CardDescription>From the parts lists in SAP, priced as the calculation prices them.</CardDescription>
    </CardHeader>
    <CardContent>
      {impact.products.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No product in the parts lists uses these parts</EmptyTitle>
            <EmptyDescription>
              With production orders, Grasp also finds which customers received them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Parts affected</TableHead>
              {notice.kind === "price" ? (
                <>
                  <TableHead>Price now</TableHead>
                  <TableHead>New price</TableHead>
                  <TableHead>Difference</TableHead>
                </>
              ) : null}
              <TableHead>Check</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {impact.products.map((product) => (
              <TableRow key={product.number}>
                <TableCell>{[product.name, product.number].join(" · ")}</TableCell>
                <TableCell>{product.customer}</TableCell>
                <TableCell>{product.uses.length}</TableCell>
                {notice.kind === "price" ? (
                  <>
                    <TableCell>{money(product.now)}</TableCell>
                    <TableCell>{money(product.after)}</TableCell>
                    <TableCell>{change(product.after - product.now)}</TableCell>
                  </>
                ) : null}
                <TableCell>
                  <Badge
                    render={<Link params={{ number: product.number }} to="/products/$number" />}
                    variant={product.findings === 0 ? "passed" : "attention"}
                  >
                    {product.findings === 0
                      ? "Agrees"
                      : [amount(product.findings), product.findings === 1 ? "finding" : "findings"].join(" ")}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </CardContent>
  </Card>
);

const Articles = ({ notice, impact }: { notice: Notice; impact: Impact }) => {
  const [all, setAll] = useState(false);
  const shown = all ? impact.articles : impact.articles.slice(0, firstArticles);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Articles</CardTitle>
        <CardDescription>
          {[amount(impact.count), "from", notice.supplierName ?? notice.supplier, "· most in stock first · price list, else last purchase price"].join(" ")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Article</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Supplier part</TableHead>
              <TableHead>In stock</TableHead>
              <TableHead>Price</TableHead>
              {notice.kind === "price" ? <TableHead>New price</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((article) => (
              <TableRow key={article.number}>
                <TableCell>{article.number}</TableCell>
                <TableCell>{article.description}</TableCell>
                <TableCell>{article.supplierPart}</TableCell>
                <TableCell>{amount(article.stock)}</TableCell>
                <TableCell>{article.price === null ? "–" : money(article.price)}</TableCell>
                {notice.kind === "price" ? (
                  <TableCell>{article.newPrice === null ? "–" : money(article.newPrice)}</TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {impact.articles.length > firstArticles ? (
        <CardFooter>
          <Button onClick={() => setAll(!all)} variant="ghost">
            {all ? "Show fewer" : ["Show all", amount(impact.articles.length)].join(" ")}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
};

const Message = ({ notice, forCustomers }: { notice: Notice; forCustomers: boolean }) => {
  const approve = useMutation(api.notices.approve);
  const [text, setText] = useState(notice.message ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const approved = notice.status === "approved";
  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await approve({ id: notice._id, message: text });
    } catch (error) {
      setFailure(failureOf(error));
    }
    setBusy(false);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{forCustomers ? "Message to customers" : "Note for Quality"}</CardTitle>
        <CardDescription>
          {approved && notice.approvedAt !== null
            ? ["Approved by", notice.approvedBy ?? "", "on", day(notice.approvedAt)].join(" ")
            : "Written by Grasp from the figures above. Change what you like, then approve it."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Textarea
          aria-label={forCustomers ? "Message to customers" : "Note for Quality"}
          disabled={approved || busy}
          onChange={(event) => setText(event.target.value)}
          rows={12}
          value={text}
        />
      </CardContent>
      <CardFooter>
        <div className="flex items-center gap-3">
          {approved ? (
            <Badge variant="passed">Approved</Badge>
          ) : (
            <Button disabled={busy || text.trim() === ""} onClick={submit} variant="highlight">
              {busy ? <Spinner /> : null}
              Approve
            </Button>
          )}
          {failure === null ? null : <span>{failure}</span>}
        </div>
      </CardFooter>
    </Card>
  );
};

const LetterText = ({ letter }: { letter: string }) => (
  <Card>
    <CardHeader>
      <CardTitle>The letter</CardTitle>
    </CardHeader>
    <CardContent className="max-h-96 overflow-y-auto whitespace-pre-wrap">
      {letter}
    </CardContent>
  </Card>
);

/** A letter Grasp is reading or read: its steps, and what came of each. */
const Reading = ({ notice }: { notice: Notice }) => {
  const impact = useQuery(api.notices.impact, { id: notice._id });
  const ready = notice.status === "read" || notice.status === "approved";
  return (
    <>
      <Grid columns={2}>
        <Steps impact={impact} notice={notice} />
        <WhatItSays notice={notice} />
      </Grid>
      {impact === undefined || impact === null ? null : (
        <>
          <Grid columns={4}>
            <Figure label="Articles" note={[amount(impact.inStock), "in stock"].join(" ")} value={amount(impact.count)} />
            <Figure label="Products" note="in the parts lists" value={amount(impact.products.length)} />
            <Figure
              label="Change"
              note={notice.kind === "price" ? "on every article" : "to the parts listed"}
              value={notice.kind === "price" ? percentOf(notice) : "Drawing"}
            />
            <Figure label="From" note="as the letter says" value={notice.effective ?? "–"} />
          </Grid>
          {ready ? <AlsoFound impact={impact} /> : null}
          <ProductsTouched impact={impact} notice={notice} />
        </>
      )}
      {ready ? (
        <Message
          forCustomers={impact === undefined || impact === null || impact.products.length > 0}
          key={notice.message ?? ""}
          notice={notice}
        />
      ) : null}
      {impact === undefined || impact === null ? null : <Articles impact={impact} notice={notice} />}
      <LetterText letter={notice.letter} />
    </>
  );
};

const Letter = () => {
  const { noticeId } = Route.useParams();
  const notice = useQuery(api.notices.get, { id: noticeId });
  const read = useAction(api.notices.read);
  const write = useAction(api.notices.write);
  const startOver = useMutation(api.notices.startOver);
  const user = useUser();
  const builds = user?.roles.includes("builder") === true;
  const [starting, setStarting] = useState(false);
  if (notice === undefined) {
    return <Skeleton className="m-6 h-9 w-64" />;
  }
  if (notice === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>This letter is gone</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  const status = statuses[notice.status];
  const readLetter = async () => {
    setStarting(true);
    await handOver(read, write, notice._id);
    setStarting(false);
  };
  return (
    <main className="flex flex-col gap-6 p-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>{notice.title}</PageHeaderTitle>
          <PageHeaderDescription>
            {[notice.supplier, day(notice.received)].join(" · ")}
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          {notice.status !== "new" && builds ? (
            <Button onClick={async () => await startOver({ id: notice._id })} variant="ghost">
              Start over
            </Button>
          ) : null}
          {notice.status === "new" ? (
            <Button disabled={starting} onClick={readLetter} variant="highlight">
              {starting ? <Spinner /> : null}
              Read with Grasp
            </Button>
          ) : (
            <Badge variant={status.variant}>
              {status.busy ? <Spinner /> : null}
              {status.label}
            </Badge>
          )}
        </PageHeaderActions>
      </PageHeader>
      {notice.problem === null || notice.status !== "new" ? null : (
        <Alert variant="destructive">
          <AlertTitle>Grasp couldn&apos;t read the letter</AlertTitle>
          <AlertDescription>{notice.problem}</AlertDescription>
        </Alert>
      )}
      {notice.status === "new" ? <LetterText letter={notice.letter} /> : <Reading notice={notice} />}
    </main>
  );
};

export const Route = createFileRoute("/letters/$noticeId")({
  // A letter's ID, read from the address: the server checks it on every call.
  params: { parse: ({ noticeId }) => ({ noticeId: noticeId as Id<"notices"> }) },
  component: Letter,
});
`;

const product = `import { useQuery } from "@grasp-os/sdk/react";
import { Badge } from "@grasp-os/app-kit/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/app-kit/components/card";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/app-kit/components/empty";
import { Grid } from "@grasp-os/app-kit/components/grid";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/app-kit/components/item";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/app-kit/components/page-header";
import { Skeleton } from "@grasp-os/app-kit/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/app-kit/components/table";
import { api } from "@server/_generated/api";
import { createFileRoute } from "@tanstack/react-router";

import { Figure } from "../components/figure";
import { amount, change, money } from "../lib/format";

const issues = {
  quantity: "Quantity",
  price: "No price",
  notOnDrawing: "Not on drawing",
  notInSap: "Not in SAP",
  part: "Part number",
} as const;

const Product = () => {
  const { number } = Route.useParams();
  const check = useQuery(api.products.check, { number });
  if (check === undefined) {
    return <Skeleton className="m-6 h-9 w-64" />;
  }
  if (check === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No product has this number</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  const { assembly, findings, lines, prices } = check;
  const [single] = prices;
  return (
    <main className="flex flex-col gap-6 p-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>{assembly.name}</PageHeaderTitle>
          <PageHeaderDescription>
            {[assembly.number, ["REV", assembly.revision].join(" "), assembly.customer].join(" · ")}
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <Badge variant={findings.length === 0 ? "passed" : "attention"}>
            {findings.length === 0
              ? "Drawing, SAP and price agree"
              : [amount(findings.length), findings.length === 1 ? "finding" : "findings"].join(" ")}
          </Badge>
        </PageHeaderActions>
      </PageHeader>
      <Grid columns={4}>
        <Figure label="Price for one" note="per piece" value={single === undefined ? "–" : money(single.price)} />
        <Figure label="Parts" note={["with ", amount(assembly.margin * 100), "% margin"].join("")} value={money(check.parts)} />
        <Figure label="Labour" note={money(check.labour)} value={[amount(assembly.labourMinutes), "min"].join(" ")} />
        <Figure attention={findings.length > 0} label="Findings" note="to look at" value={amount(findings.length)} />
      </Grid>
      <Card>
        <CardHeader>
          <CardTitle>What doesn&apos;t match</CardTitle>
          <CardDescription>
            {["The drawing the customer approves", assembly.drawing === "" ? "" : ["(", assembly.drawing, ")"].join(""), "against SAP and the price."].join(" ")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {findings.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>The drawing, SAP and the price agree</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup spacing="tight">
              {findings.map((finding) => (
                <Item key={[finding.kind, finding.title].join(":")} variant="outline">
                  <ItemContent>
                    <ItemTitle>{finding.title}</ItemTitle>
                    <ItemDescription>{finding.detail}</ItemDescription>
                  </ItemContent>
                  {finding.effect === null ? null : (
                    <ItemActions>
                      <Badge variant="attention">
                        {[finding.estimate ? "about" : "", change(finding.effect), "a piece"].join(" ").trim()}
                      </Badge>
                    </ItemActions>
                  )}
                </Item>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>
      <Grid columns={2}>
        <Card>
          <CardHeader>
            <CardTitle>Price per piece</CardTitle>
            <CardDescription>By how many are ordered at once.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ordered</TableHead>
                  <TableHead>Per piece</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prices.map((tier) => (
                  <TableRow key={tier.quantity}>
                    <TableCell>{amount(tier.quantity)}</TableCell>
                    <TableCell>{money(tier.price)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>How the price is built</CardTitle>
            <CardDescription>For one piece.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                <TableRow>
                  <TableHead>Parts, with margin</TableHead>
                  <TableCell>{money(check.parts)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableHead>Labour</TableHead>
                  <TableCell>{money(check.labour)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableHead>Production order</TableHead>
                  <TableCell>{money(assembly.orderCost)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Grid>
      <Card>
        <CardHeader>
          <CardTitle>Parts list</CardTitle>
          <CardDescription>Each line of the drawing beside SAP.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Part</TableHead>
                <TableHead>Article</TableHead>
                <TableHead>Drawing</TableHead>
                <TableHead>SAP</TableHead>
                <TableHead>Unit price</TableHead>
                <TableHead>Check</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.position}>
                  <TableCell>{line.position}</TableCell>
                  <TableCell>{line.name}</TableCell>
                  <TableCell>{line.article ?? "–"}</TableCell>
                  <TableCell>{line.drawing === null ? "–" : [amount(line.drawing), line.unit].join(" ")}</TableCell>
                  <TableCell>{line.sap === null ? "–" : [amount(line.sap), line.unit].join(" ")}</TableCell>
                  <TableCell>{line.price === null ? "–" : money(line.price)}</TableCell>
                  <TableCell>
                    {line.issue === null ? null : <Badge variant="attention">{issues[line.issue]}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/products/$number")({ component: Product });
`;

const tests = `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "@server/_generated/api";
import { expect } from "vitest";

import schema from "../server/schema";

const article = (number: string, supplier: string, listPrice: number | null) => ({
  number,
  description: ["Part", number].join(" "),
  supplier,
  supplierPart: ["SP", number].join("-"),
  unit: "PC",
  stock: 5,
  lastPurchasePrice: 4,
  listPrice,
  active: true,
});

const product = {
  number: "P1",
  name: "Transfer set",
  revision: "A",
  customer: "A customer",
  labourMinutes: 10,
  labourRate: 2,
  orderCost: 100,
  margin: 0.2,
  drawing: "",
};

const line = (position: number, part: string, quantity: number) => ({
  assembly: "P1",
  position,
  article: part,
  quantity,
  unit: "PC",
});

const drawn = (position: number, part: string, quantity: number) => ({
  assembly: "P1",
  position,
  description: ["Part", part].join(" "),
  supplierPart: ["SP", part].join("-"),
  quantity,
  unit: "PC",
});

export default appTest(schema, {
  "a product check finds where the drawing, SAP and the price disagree": async (t) => {
    await t.run(async (ctx) => {
      await ctx.db.insert("articles", article("A", "Acme", 10));
      await ctx.db.insert("articles", article("B", "Acme", null));
      await ctx.db.insert("assemblies", product);
      await ctx.db.insert("bomLines", line(1, "A", 1));
      await ctx.db.insert("bomLines", line(2, "B", 2));
      await ctx.db.insert("bomLines", line(3, "A", 1));
      await ctx.db.insert("drawingLines", drawn(1, "A", 2));
      await ctx.db.insert("drawingLines", drawn(2, "B", 2));
    });
    const ada = t.withIdentity({ name: "Ada" });
    const check = await ada.query(api.products.check, { number: "P1" });
    expect(check?.findings.map(({ kind, effect }) => [kind, effect])).toStrictEqual([
      ["quantity", 12.5],
      ["notOnDrawing", -12.5],
      ["price", 10],
    ]);
    // Parts 20 with a 20% margin, 20 of labour, and the order's 100 for one piece.
    expect(check?.prices[0]).toStrictEqual({ quantity: 1, price: 145 });
  },
  "a price letter raises what its supplier's parts cost in each product": async (t) => {
    const id = await t.run(async (ctx) => {
      await ctx.db.insert("articles", article("A", "Acme", 10));
      await ctx.db.insert("articles", article("C", "Other", 10));
      await ctx.db.insert("assemblies", product);
      await ctx.db.insert("bomLines", line(1, "A", 1));
      await ctx.db.insert("bomLines", line(2, "C", 1));
      return await ctx.db.insert("notices", {
        supplier: "Acme",
        title: "Prices",
        received: 0,
        letter: "Prices go up 10%.",
        status: "read",
        kind: "price",
        supplierName: "Acme",
        percent: 10,
      });
    });
    const ada = t.withIdentity({ name: "Ada" });
    const impact = await ada.query(api.notices.impact, { id });
    expect(impact?.count).toBe(1);
    // Acme's part goes from 10 to 11: 1.25 more with the margin.
    expect(impact?.products.map(({ now, after }) => [now, after])).toStrictEqual([[145, 146.25]]);
  },
  "a letter is approved only once Grasp read it": async (t) => {
    const id = await t.run(
      async (ctx) =>
        await ctx.db.insert("notices", {
          supplier: "Acme",
          title: "Prices",
          received: 0,
          letter: "Prices go up.",
        })
    );
    const ada = t.withIdentity({ name: "Ada" });
    await expect(
      ada.mutation(api.notices.approve, { id, message: "Dear customer," })
    ).rejects.toMatchObject({ code: "notice.not_read" });
  },
  "a letter's part numbers find SAP's parts with more after a hyphen, and only those": async (t) => {
    const id = await t.run(async (ctx) => {
      await ctx.db.insert("articles", { ...article("Y", "Acme", 10), supplierPart: "Y0-8PP-QC" });
      await ctx.db.insert("articles", { ...article("V", "Acme", 10), supplierPart: "Y0-8PPX" });
      await ctx.db.insert("articles", { ...article("W", "Acme", 10), supplierPart: "Y0-8NK" });
      await ctx.db.insert("assemblies", product);
      await ctx.db.insert("bomLines", line(1, "Y", 1));
      return await ctx.db.insert("notices", {
        supplier: "Acme",
        title: "Drawing change",
        received: 0,
        letter: "The Y0-8PP drawing changes.",
        status: "read",
        kind: "change",
        supplierName: "Acme",
        parts: ["Y0-8PP"],
      });
    });
    const ada = t.withIdentity({ name: "Ada" });
    const impact = await ada.query(api.notices.impact, { id });
    expect(impact?.articles.map(({ number }) => number)).toStrictEqual(["Y"]);
    expect(impact?.products.map(({ number }) => number)).toStrictEqual(["P1"]);
  },
  "a price letter that names parts raises only those": async (t) => {
    const id = await t.run(async (ctx) => {
      await ctx.db.insert("articles", article("A", "Acme", 10));
      await ctx.db.insert("articles", article("B", "Acme", 10));
      await ctx.db.insert("assemblies", product);
      await ctx.db.insert("bomLines", line(1, "A", 1));
      await ctx.db.insert("bomLines", line(2, "B", 1));
      return await ctx.db.insert("notices", {
        supplier: "Acme",
        title: "Prices",
        received: 0,
        letter: "SP-B goes up 10%.",
        status: "read",
        kind: "price",
        supplierName: "Acme",
        percent: 10,
        parts: ["SP-B"],
      });
    });
    const ada = t.withIdentity({ name: "Ada" });
    const impact = await ada.query(api.notices.impact, { id });
    expect(impact?.count).toBe(1);
    expect(impact?.products.map(({ now, after }) => [now, after])).toStrictEqual([[145, 146.25]]);
  },
  "a drawing naming another variant is a finding; a pack size after SAP's number isn't": async (t) => {
    await t.run(async (ctx) => {
      await ctx.db.insert("articles", { ...article("A", "Acme", 10), supplierPart: "SP-AB25" });
      await ctx.db.insert("articles", { ...article("B", "Acme", 10), supplierPart: "SP-B" });
      await ctx.db.insert("assemblies", product);
      await ctx.db.insert("bomLines", line(1, "A", 1));
      await ctx.db.insert("bomLines", line(2, "B", 1));
      await ctx.db.insert("drawingLines", { ...drawn(1, "A", 1), supplierPart: "SP-A" });
      await ctx.db.insert("drawingLines", { ...drawn(2, "B", 1), supplierPart: "SP-B-PVDF" });
    });
    const ada = t.withIdentity({ name: "Ada" });
    const check = await ada.query(api.products.check, { number: "P1" });
    expect(check?.findings.map(({ kind }) => kind)).toStrictEqual(["part"]);
  },
  "only the App's builders start a letter over": async (t) => {
    const id = await t.run(
      async (ctx) =>
        await ctx.db.insert("notices", {
          supplier: "Acme",
          title: "Prices",
          received: 0,
          letter: "Prices go up.",
          status: "read",
        })
    );
    const ada = t.withIdentity({ name: "Ada" });
    await expect(ada.mutation(api.notices.startOver, { id })).rejects.toMatchObject({
      code: "notice.builders_only",
    });
    const bea = t.withIdentity({ name: "Bea", role: "builder" });
    await bea.mutation(api.notices.startOver, { id });
    await expect(ada.query(api.notices.get, { id })).resolves.toMatchObject({ status: "new" });
  },
});
`;

/** The App's files beside the code its definition generates, by path. */
export const files: Readonly<Record<string, string>> = {
  "server/pricing.ts": pricing,
  "server/costing.ts": costing,
  "server/compare.ts": compare,
  "server/products.ts": products,
  "server/notices.ts": notices,
  "src/lib/format.ts": format,
  "src/lib/statuses.ts": statusesFile,
  "src/lib/hand-over.ts": handOverFile,
  "src/components/figure.tsx": figure,
  "src/routes/index.tsx": home,
  "src/routes/letters.$noticeId.tsx": letter,
  "src/routes/products.$number.tsx": product,
  "tests/supplier-changes.test.ts": tests,
};

/** A CSV cell: text quoted, its quotes doubled; a number, true or null as JSON. */
const cell = (value: string | number | boolean | null): string =>
  typeof value === "string"
    ? `"${value.replaceAll('"', '""')}"`
    : JSON.stringify(value);

const csv = (
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null)[])[]
): string =>
  `${[header.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\n")}\n`;

const northfield = "NORTHFIELD FITTINGS INC";
const brightline = "BRIGHTLINE TUBING GMBH";
const halden = "HALDEN FILTRATION BV";
const cleanroom = "CLEANROOM SUPPLIES LTD";

const day = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** The made-up company's data, as the CSVs its exports would be. */
export const demoData: Readonly<Record<TableName, readonly string[]>> = {
  articles: [
    csv(
      [
        "number",
        "description",
        "supplier",
        "supplierPart",
        "unit",
        "stock",
        "lastPurchasePrice",
        "listPrice",
        "active",
      ],
      [
        [
          "7000101",
          'NF T-connector PP 1/2" HB',
          northfield,
          "NF-T08-PP",
          "PC",
          420,
          0.95,
          1.1,
          true,
        ],
        [
          "7000102",
          'NF Reducer PP 1/2" x 1/4" HB',
          northfield,
          "NF-R84-PP",
          "PC",
          310,
          0.88,
          1.02,
          true,
        ],
        [
          "7000103",
          'NF End plug PP 3/8" HB',
          northfield,
          "NF-P06-PP",
          "PC",
          150,
          0.7,
          0.84,
          true,
        ],
        [
          "7000104",
          'NF Y-connector PP 1/2" HB',
          northfield,
          "NF-Y08-PP-QC",
          "PC",
          640,
          1.2,
          1.38,
          true,
        ],
        [
          "7000105",
          'NF Y-connector PVDF 1/2" HB',
          northfield,
          "NF-Y08-PVDF",
          "PC",
          0,
          2.1,
          2.45,
          true,
        ],
        [
          "7000106",
          'NF Y-connector nylon 1/2" HB',
          northfield,
          "NF-Y08-NN",
          "PC",
          85,
          1.05,
          1.19,
          true,
        ],
        [
          "7000107",
          'NF Elbow PP 1/2" HB',
          northfield,
          "NF-L08-PP",
          "PC",
          0,
          0.9,
          1.04,
          false,
        ],
        [
          "7000201",
          'Platinum-cured silicone tubing 1/2" ID x 3/4" OD',
          brightline,
          "BT-S12-34",
          "CM",
          4500,
          0.11,
          0.14,
          true,
        ],
        [
          "7000202",
          'Braid-reinforced silicone tubing 1/2" ID x 7/8" OD',
          brightline,
          "BT-R12-78F",
          "CM",
          1200,
          0.62,
          null,
          true,
        ],
        [
          "7000203",
          'TPE tubing 1/4" ID x 3/8" OD',
          brightline,
          "BT-T14-38",
          "CM",
          3000,
          0.015,
          0.02,
          true,
        ],
        [
          "7000301",
          'Sterile capsule filter 0.2 µm, 1/2" HB',
          halden,
          "HF-C02-12",
          "PC",
          24,
          182,
          214.5,
          true,
        ],
        [
          "7000302",
          "Vent filter 0.2 µm PTFE",
          halden,
          "HF-V02-PT",
          "PC",
          60,
          8.4,
          9.9,
          true,
        ],
        [
          "7000401",
          "PA/PE bag 300 x 400 mm",
          cleanroom,
          "CS-B34",
          "PC",
          900,
          0.95,
          1.2,
          true,
        ],
        [
          "7000402",
          'Tube clamp 1/2" - 1", nylon',
          cleanroom,
          "CS-TC100",
          "PC",
          210,
          4.1,
          null,
          true,
        ],
        [
          "7000403",
          'Pressure sensor, polycarbonate, 1/2" HB',
          cleanroom,
          "CS-PS050",
          "PC",
          18,
          38,
          44.6,
          true,
        ],
        [
          "7000404",
          "Earclamp stepless 20.3–23.5 mm",
          cleanroom,
          "CS-EC235",
          "PC",
          2000,
          0.48,
          0.62,
          true,
        ],
      ]
    ),
  ],
  assemblies: [
    csv(
      [
        "number",
        "name",
        "revision",
        "customer",
        "labourMinutes",
        "labourRate",
        "orderCost",
        "margin",
        "drawing",
      ],
      [
        [
          "9100001",
          "Filter transfer set",
          "B",
          "Demo Biologics",
          48,
          3,
          690,
          0.15,
          "9100001 Filter transfer set REV B.pdf",
        ],
        [
          "9100002",
          "Sampling manifold",
          "A",
          "Demo Vaccines",
          64,
          3,
          690,
          0.15,
          "9100002 Sampling manifold REV A.pdf",
        ],
      ]
    ),
  ],
  bomLines: [
    csv(
      ["assembly", "position", "article", "quantity", "unit"],
      [
        ["9100001", 1, "7000201", 80, "CM"],
        ["9100001", 2, "7000101", 2, "PC"],
        ["9100001", 3, "7000301", 1, "PC"],
        ["9100001", 4, "7000302", 1, "PC"],
        ["9100001", 5, "7000202", 40, "CM"],
        ["9100001", 6, "7000402", 2, "PC"],
        ["9100001", 7, "7000403", 1, "PC"],
        ["9100001", 8, "7000404", 6, "PC"],
        ["9100001", 9, "7000401", 2, "PC"],
        ["9100001", 10, "7000401", 2, "PC"],
        ["9100002", 1, "7000203", 120, "CM"],
        ["9100002", 2, "7000104", 3, "PC"],
        ["9100002", 3, "7000102", 2, "PC"],
        ["9100002", 4, "7000103", 3, "PC"],
        ["9100002", 5, "7000302", 1, "PC"],
        ["9100002", 6, "7000401", 1, "PC"],
      ]
    ),
  ],
  drawingLines: [
    csv(
      [
        "assembly",
        "position",
        "description",
        "supplierPart",
        "quantity",
        "unit",
      ],
      [
        [
          "9100001",
          1,
          'Platinum-cured silicone tubing 1/2" x 3/4"',
          "BT-S12-34",
          80,
          "CM",
        ],
        ["9100001", 2, 'T-connector PP 1/2" HB', "NF-T08-PP", 2, "PC"],
        [
          "9100001",
          3,
          'Sterile capsule filter 0.2 µm, 1/2" HB',
          "HF-C02-12",
          2,
          "PC",
        ],
        ["9100001", 4, "Vent filter 0.2 µm PTFE", "HF-V02-PT", 1, "PC"],
        [
          "9100001",
          5,
          'Braid-reinforced silicone tubing 1/2" x 7/8"',
          "BT-R12-78",
          40,
          "CM",
        ],
        ["9100001", 6, 'Tube clamp 1/2" - 1"', "CS-TC100", 2, "PC"],
        ["9100001", 7, 'Pressure sensor 1/2" HB', "CS-PS050", 1, "PC"],
        ["9100001", 8, "Earclamp stepless 20.3–23.5 mm", "CS-EC235", 6, "PC"],
        ["9100001", 9, "PA/PE bag", null, 2, "PC"],
        ["9100002", 1, 'TPE tubing 1/4" x 3/8"', "BT-T14-38", 120, "CM"],
        ["9100002", 2, 'Y-connector PP 1/2" HB', "NF-Y08-PP-QC", 3, "PC"],
        ["9100002", 3, 'Reducer PP 1/2" x 1/4" HB', "NF-R84-PP", 2, "PC"],
        ["9100002", 4, 'End plug PP 3/8" HB', "NF-P06-PP", 3, "PC"],
        ["9100002", 5, "Vent filter 0.2 µm PTFE", "HF-V02-PT", 1, "PC"],
        ["9100002", 6, "PA/PE bag", null, 1, "PC"],
      ]
    ),
  ],
  notices: [
    csv(
      ["supplier", "title", "received", "letter"],
      [
        [
          "Northfield Fittings",
          "2027 price adjustment",
          day("2026-11-12"),
          [
            "Dear customer,",
            "",
            "Over the past year the cost of resin, tooling and skilled labour has kept rising. To keep making our fittings to the standard you rely on, Northfield Fittings will adjust its prices by 5% on all products, effective 1 March 2027.",
            "",
            "Orders placed before that date are invoiced at today's prices. Please contact your account manager to plan ahead.",
            "",
            "Sincerely,",
            "Northfield Fittings, Sales",
          ].join("\n"),
        ],
        [
          "Northfield Fittings",
          "PCN 2026-14: Y-connector drawing update",
          day("2026-10-02"),
          [
            "Product Change Notice",
            "",
            "Date of notice: October 2, 2026",
            "Notice of change: drawing dimensional update.",
            "Products affected: NF-Y08-PP, NF-Y08-PVDF, NF-Y08-NN",
            "Effective date: November 1, 2026",
            "",
            "The drawing was revised from C to D to match the nominal values of the molded part. No impact on fit, form, function, reliability or quality. Materials, processes and catalog numbers are unchanged.",
            "",
            "Northfield Fittings Quality Department",
          ].join("\n"),
        ],
      ]
    ),
  ],
};
