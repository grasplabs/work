import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import worker from "../src/index.ts";
import { finished } from "./runs.ts";
import type { signedInApi } from "./sign-in.ts";

// Email triggers: Email Routing hands core's email handler each message
// for the deployment's domain, which starts the workflow that receives
// mail at its address, with the message as input. Tests deliver messages
// to the handler as Email Routing does. What the tests of email triggers
// share; each test file signs people in with an IdP of its own
// (`mockIdp()` registers hooks, so it can't be called here).

/** A signed-in person's API. */
export type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * The invoice intake workflow, receiving mail at `address` (through
 * `times` triggers there): it returns what it read of the message it
 * started with.
 */
export const intake = (
  address = "invoices",
  id = "intake",
  times = 1
): Record<string, string> => ({
  [`workflows/${id}.ts`]: `import { emailMessage, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "${id}",
  { params: {}, input: emailMessage, triggers: [${Array.from({ length: times }, () => `{ type: "email", address: "${address}" }`).join(", ")}] },
  async (step, { input }) =>
    await step.do("read", { description: "Read the invoice mail" }, async () => ({
      id: input.id,
      stored: input.stored,
      from: input.from.address,
      to: input.to.length,
      subject: input.subject,
      text: input.text,
      last: [...input.text].at(-1) ?? "",
      truncated: input.truncated,
      attachments: input.attachments.map(({ filename, size }) => filename + ":" + size),
      size: JSON.stringify(input).length,
    }))
);
`,
  [`workflows/${id}.workflow-tests.ts`]: `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./${id}.ts";

const input = { id: "m", stored: null, from: { name: "", address: "a@b.test" }, to: [], cc: [], subject: "", date: null, text: "", truncated: false, attachments: [] };

export default workflowTests(definition, [{ name: "runs", input, mocks: { read: null }, expect: { output: null } }]);
`,
});

/**
 * A message from Ben, with an attachment, as it goes over the wire: with a
 * Message-ID and a Received header when given, and `to`, the subject, the
 * attachment's name and the text as given.
 */
export const invoiceMail = ({
  subject = "Invoice INV-7",
  messageId,
  receivedBy,
  to = "invoices@grasp.test",
  filename = "inv-7.pdf",
  text = "Please pay by Friday.",
  from = "Ben <ben@acme.test>",
  headers = [],
}: {
  subject?: string;
  messageId?: string;
  receivedBy?: string;
  to?: string;
  filename?: string;
  text?: string;
  from?: string;
  headers?: string[];
} = {}): string =>
  [
    ...(receivedBy === undefined
      ? []
      : [`Received: from ${receivedBy}; Mon, 28 Sep 2026 08:00:01 +0000`]),
    ...(messageId === undefined ? [] : [`Message-ID: <${messageId}>`]),
    ...headers,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Date: Mon, 28 Sep 2026 08:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "--b",
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0=",
    "--b--",
    "",
  ].join("\r\n");

/** What became of a delivery: the reason it was rejected with, if it was. */
export interface Delivery {
  rejected: string | undefined;
}

/**
 * Delivers `raw` to `to`, as Email Routing does, on an env with `changes`;
 * `rawSize` is the size the message says it is.
 */
export const deliver = async (
  to: string,
  raw: string,
  {
    changes = {},
    rawSize,
    envelopeFrom = "bounces@acme.test",
  }: { changes?: Partial<Env>; rawSize?: number; envelopeFrom?: string } = {}
): Promise<Delivery> => {
  const bytes = new TextEncoder().encode(raw);
  const delivery: Delivery = { rejected: undefined };
  const message: ForwardableEmailMessage = {
    from: envelopeFrom,
    to,
    raw: new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: new Headers(),
    rawSize: rawSize ?? bytes.byteLength,
    setReject: (reason) => {
      delivery.rejected = reason;
    },
    forward: async () =>
      await Promise.reject(new Error("Core never forwards mail")),
    reply: async () =>
      await Promise.reject(new Error("Core never replies to mail")),
  };
  const ctx = createExecutionContext();
  await worker.email(message, { ...env, ...changes }, ctx);
  await waitOnExecutionContext(ctx);
  return delivery;
};

/** The App's runs, as its builder sees them. */
export const runsOf = async (builder: Person, app: string) =>
  await builder.api.workflows.list(app);

const outputSchema = z.object({
  id: z.string(),
  stored: z.string().nullable(),
  from: z.string(),
  to: z.number(),
  subject: z.string(),
  text: z.string(),
  last: z.string(),
  truncated: z.boolean(),
  attachments: z.array(z.string()),
  size: z.number(),
});

/** What each of the App's runs read of the message it started with. */
export const readByRuns = async (builder: Person, app: string) => {
  const runs = await runsOf(builder, app);
  return await Promise.all(
    runs.map(async ({ id }) => {
      await finished(id);
      const { output } = await builder.api.workflows.status(id);
      return outputSchema.parse(output);
    })
  );
};

/** What the App's only run read of the message it started with. */
export const readByRun = async (builder: Person, app: string) => {
  const [read] = await readByRuns(builder, app);
  if (!read) {
    throw new Error(`App ${app} has no run`);
  }
  return read;
};

/**
 * Every kept message in R2 (workflows/kept-email.ts), as its key and when
 * it was stored. Kept mail only, not the whole bucket: other parts of core
 * write there too, on their own schedule. The mail a test delivers arms
 * the clock (index.ts), which after each file's reset starts empty and
 * runs every task as soon as it is armed. Its sweeps then write their
 * cursors (`builds-sweep.json`, `screen-frames-sweep.json`) while the
 * test is still going.
 */
export const storedObjects = async (): Promise<string[]> => {
  const listed = await env.FILES.list({
    prefix: "inbound-email/",
    limit: 1000,
  });
  return listed.objects.map(
    ({ key, uploaded }) => `${key}@${uploaded.toISOString()}`
  );
};

/** The keys of the objects in R2 that `before` didn't list. */
export const addedSince = async (
  before: readonly string[]
): Promise<string[]> => {
  const now = await storedObjects();
  return now
    .filter((object) => !before.includes(object))
    .map((object) => object.split("@")[0] ?? object);
};

/** A kept message's name: its day, and the SHA-256 of its bytes. */
export const storedName = /^(?<day>\d{4}-\d{2}-\d{2})\/[0-9a-f]{64}$/u;
