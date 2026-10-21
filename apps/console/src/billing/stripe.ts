import { whenAborted } from "@grasp-os/shared/deadline";
/**
 * What Grasp's Stripe holds on one customer, read through Stripe's own MCP
 * server (as every source the admin reads, @grasp-os/shared/admin/admin-sources),
 * with a restricted key that can read customers, subscriptions and
 * invoices and nothing else (`STRIPE_RESTRICTED_KEY`, Secrets Store).
 *
 * Threat model: the key is the console's alone. It is read from Secrets
 * Store on the server, sent only to Stripe's MCP server as its bearer
 * token, and never logged, kept in D1 or sent to the browser. Two things
 * keep this read-only, each enough on its own: Stripe refuses anything the
 * restricted key isn't granted, and the console only ever calls the tools
 * in `stripeReadTools`, each a read (`callRead` refuses any other name
 * before anything is sent). What Stripe answers is untrusted: every answer
 * is checked against what the console reads of it, and an invoice or
 * subscription of any customer but the one asked for is dropped, so one
 * company is never shown another's.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";

/** Stripe's remote MCP server, which takes a (restricted) secret key as its bearer token. */
export const stripeMcpUrl = "https://mcp.stripe.com/";

/**
 * The only tools the console calls on Stripe's MCP server, every one a
 * read: one object by its id (the customer), and a customer's
 * subscriptions and invoices. Anything else (creating, updating,
 * cancelling, refunding) is never called, whatever the server lists.
 */
export const stripeReadTools = [
  "fetch_stripe_resources",
  "list_subscriptions",
  "list_invoices",
] as const;
export type StripeReadTool = (typeof stripeReadTools)[number];

/** How many of a customer's invoices are read, the newest first: two years of monthly ones. */
export const invoicesRead = 24;

/**
 * Why Stripe wasn't read, as a code: what is logged and shown, never an
 * answer's body.
 * - `refused`: Stripe turned the key away (401, 403);
 * - `not_found`: Stripe has no such customer, or it was deleted;
 * - `tool_error`: a tool answered with an error;
 * - `invalid_answer`: an answer isn't what Stripe's objects look like;
 * - `timeout`: no answer within the deadline;
 * - `no_answer`: the request failed otherwise.
 */
export type StripeReadError =
  | "refused"
  | "not_found"
  | "tool_error"
  | "invalid_answer"
  | "timeout"
  | "no_answer";

/** A Unix time, in seconds, as Stripe gives it. */
const unix = z.number().int();

const collectionMethod = z.enum(["charge_automatically", "send_invoice"]);

/** The customer, as far as the console reads it. */
const customerSchema = z.looseObject({
  id: z.string(),
  object: z.literal("customer"),
  name: z.string().nullish(),
  currency: z.string().nullish(),
  deleted: z.boolean().optional(),
});
export type StripeCustomer = z.output<typeof customerSchema>;

/** A customer Stripe deleted: what it answers for one by its id. */
const deletedCustomerSchema = z.looseObject({
  id: z.string(),
  deleted: z.literal(true),
});

/** A reference to a customer: its id, or the customer itself where expanded. */
const customerRef = z.union([z.string(), z.looseObject({ id: z.string() })]);

/** An invoice, as far as the console reads it. */
const invoiceSchema = z.looseObject({
  id: z.string(),
  customer: customerRef,
  number: z.string().nullish(),
  status: z.enum(["draft", "open", "paid", "uncollectible", "void"]).nullish(),
  created: unix,
  due_date: unix.nullish(),
  total: z.number().int(),
  amount_remaining: z.number().int(),
  currency: z.string(),
  /** Stripe has tried to collect it: for one it charges itself, that payment failed. */
  attempted: z.boolean().optional(),
  collection_method: collectionMethod.optional(),
  status_transitions: z.looseObject({ paid_at: unix.nullish() }).nullish(),
});
export type StripeInvoice = z.output<typeof invoiceSchema>;

/** One item of a subscription: what it bills, and until when, where Stripe's API version puts it there. */
const subscriptionItemSchema = z.looseObject({
  quantity: z.number().int().nullish(),
  current_period_end: unix.optional(),
  price: z
    .looseObject({
      unit_amount: z.number().int().nullish(),
      currency: z.string(),
    })
    .nullish(),
});

/** A subscription, as far as the console reads it. */
const subscriptionSchema = z.looseObject({
  id: z.string(),
  customer: customerRef,
  status: z.string(),
  currency: z.string().optional(),
  collection_method: collectionMethod.optional(),
  days_until_due: z.number().int().nullish(),
  cancel_at_period_end: z.boolean().optional(),
  cancel_at: unix.nullish(),
  /** Where API versions before 2025-03-31 put it; later ones put it on each item. */
  current_period_end: unix.optional(),
  items: z.looseObject({ data: z.array(subscriptionItemSchema) }).optional(),
});
export type StripeSubscription = z.output<typeof subscriptionSchema>;

/** What Stripe holds on one customer. */
export interface StripeRecords {
  customer: StripeCustomer;
  /** Its subscriptions that aren't cancelled, the newest first. */
  subscriptions: StripeSubscription[];
  /** Its latest invoices, the newest first. */
  invoices: StripeInvoice[];
}

/** A tool's answer that isn't what the console reads: what it says is never passed on. */
class StripeAnswerError extends Error {
  readonly code: StripeReadError;

  constructor(code: StripeReadError) {
    super(`Stripe's MCP server answered ${code}`);
    this.name = "StripeAnswerError";
    this.code = code;
  }
}

const isReadTool = (name: string): name is StripeReadTool =>
  stripeReadTools.some((tool) => tool === name);

const textBlock = z.looseObject({ type: z.literal("text"), text: z.string() });

/**
 * What a tool's result holds, as JSON: its structured content, or else its
 * text, which Stripe's server fills with the object or list it read.
 */
const resultData = (result: Record<string, unknown>): unknown => {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = z.array(z.unknown()).safeParse(result.content).data ?? [];
  const text = content
    .map((block) => textBlock.safeParse(block).data?.text)
    .find((each) => each !== undefined);
  if (text === undefined) {
    throw new StripeAnswerError("invalid_answer");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StripeAnswerError("invalid_answer");
  }
};

/**
 * Calls read tool `tool` with `input`, and returns what it read. Refuses,
 * before anything is sent, a tool that isn't one of `stripeReadTools`:
 * the type says so, and so does this check, for a name that got past it.
 */
const callRead = async (
  client: Client,
  tool: StripeReadTool,
  input: Record<string, string | number>,
  signal: AbortSignal
): Promise<unknown> => {
  if (!isReadTool(tool)) {
    throw new Error(`${String(tool)} isn't a Stripe tool the console reads`);
  }
  const result = await client.callTool(
    { name: tool, arguments: input },
    undefined,
    {
      signal,
    }
  );
  if (result.isError === true) {
    throw new StripeAnswerError("tool_error");
  }
  return resultData(result);
};

/** A list as Stripe's server answers it: the list itself, or Stripe's `{ data }` envelope. */
const listOf = <T extends z.ZodType>(item: T) =>
  z
    .union([z.array(item), z.looseObject({ data: z.array(item) })])
    .transform((list): z.output<T>[] =>
      Array.isArray(list) ? list : list.data
    );

const parsed = <T extends z.ZodType>(schema: T, data: unknown): z.output<T> => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new StripeAnswerError("invalid_answer");
  }
  return result.data;
};

/** The id a reference names. */
const idOf = (ref: z.output<typeof customerRef>): string =>
  typeof ref === "string" ? ref : ref.id;

/** Whether `error` is the server turning the key away: an HTTP 401 or 403. */
const isRefusal = (error: unknown): boolean => {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === 401 || error.code === 403;
};

/** What reading a customer takes. */
export interface StripeReadOptions {
  /** The restricted key, from Secrets Store. */
  key: string;
  /** The customer to read, as linked by hand. */
  customerId: string;
  /** Stops the read: the caller's deadline. */
  signal: AbortSignal;
}

/**
 * Customer `customerId`'s records in Stripe, read through its MCP server
 * one tool at a time, or why they weren't. Throws only when `signal`
 * aborts, so the caller can tell its deadline from a failure.
 */
export const readStripeCustomer = async ({
  key,
  customerId,
  signal,
}: StripeReadOptions): Promise<
  { records: StripeRecords } | { error: StripeReadError }
> => {
  const transport = new StreamableHTTPClientTransport(new URL(stripeMcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
    // Every request the transport sends ends with the caller's deadline,
    // or sooner, as the transport itself stops it.
    fetch: async (url, init) =>
      await fetch(url, {
        ...init,
        signal:
          init?.signal === undefined || init.signal === null
            ? signal
            : AbortSignal.any([init.signal, signal]),
      }),
  });
  const client = new Client(
    { name: "grasp-os-console", version: "1.0.0" },
    // Workers allow no code generation, which the SDK's default validator needs.
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
  );
  const read = async (): Promise<StripeRecords> => {
    await client.connect(transport, { signal });
    const answer = await callRead(
      client,
      "fetch_stripe_resources",
      { id: customerId },
      signal
    );
    if (deletedCustomerSchema.safeParse(answer).success) {
      throw new StripeAnswerError("not_found");
    }
    const customer = parsed(customerSchema, answer);
    if (customer.id !== customerId) {
      throw new StripeAnswerError("not_found");
    }
    const subscriptions = parsed(
      listOf(subscriptionSchema),
      await callRead(
        client,
        "list_subscriptions",
        { customer: customerId, limit: 10 },
        signal
      )
    );
    const invoices = parsed(
      listOf(invoiceSchema),
      await callRead(
        client,
        "list_invoices",
        { customer: customerId, limit: invoicesRead },
        signal
      )
    );
    // Only what is the customer's own, whatever the server answered.
    const own = (each: { customer: z.output<typeof customerRef> }): boolean =>
      idOf(each.customer) === customerId;
    return {
      customer,
      subscriptions: subscriptions
        .filter(own)
        .filter(({ status }) => status !== "canceled"),
      invoices: invoices.filter(own).toSorted((a, b) => b.created - a.created),
    };
  };
  try {
    return {
      records: await Promise.race([read(), whenAborted(signal)]),
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    if (error instanceof StripeAnswerError) {
      return { error: error.code };
    }
    return { error: isRefusal(error) ? "refused" : "no_answer" };
  } finally {
    // Closing only stops the transport's own requests: nothing is sent.
    try {
      await client.close();
    } catch {
      // Already closed.
    }
  }
};
