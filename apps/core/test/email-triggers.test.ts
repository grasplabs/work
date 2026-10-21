import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import {
  mailFromHeader,
  mailIngressPath,
  mailSentAtHeader,
  mailSha256Header,
  mailSignatureHeader,
  mailSizeHeader,
  mailToHeader,
  signMail,
} from "@grasp-os/shared/mail-ingress";
import type { SignedMail } from "@grasp-os/shared/mail-ingress";
import type { Role } from "@grasp-os/shared/roles";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { setCurrentVersion } from "../src/apps.ts";
import worker from "../src/index.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { racingDb } from "./racing-db.ts";
import { aroundEngine, endLiveRuns, finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith } from "./workflow-apps.ts";

// Email triggers: Email Routing hands core's email handler each message
// for the deployment's domain, which starts the workflow that receives
// mail at its address, with the message as input. Tests deliver messages
// to the handler as Email Routing does.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * The invoice intake workflow, receiving mail at `address` (through
 * `times` triggers there): it returns what it read of the message it
 * started with.
 */
const intake = (
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
const invoiceMail = ({
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

/** An HTML-only message to `unclosed@`, with `subject` and `body`. */
const unclosed = (subject: string, body: string): string =>
  [
    "From: Ben <ben@acme.test>",
    "To: unclosed@grasp.test",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");

/** A message whose one attachment is inline: an image in its HTML. */
const inlineOnly = [
  "From: Ben <ben@acme.test>",
  "To: unkept@grasp.test",
  "Subject: Inline",
  "MIME-Version: 1.0",
  'Content-Type: multipart/related; boundary="r"',
  "",
  "--r",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Logo: <img src="cid:logo"></p>',
  "--r",
  "Content-Type: image/png",
  "Content-ID: <logo>",
  "Content-Disposition: inline",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0K",
  "--r--",
  "",
].join("\r\n");

/** A message of multiparts nested `depth` deep. */
const nestedMail = (depth: number): string =>
  [
    "From: Ben <ben@acme.test>",
    "To: invoices@grasp.test",
    "Subject: Nested",
    "MIME-Version: 1.0",
    ...Array.from({ length: depth }, (_, level) => [
      `Content-Type: multipart/mixed; boundary="b${level}"`,
      "",
      `--b${level}`,
    ]).flat(),
    "Content-Type: text/plain",
    "",
    "Deep.",
    "",
  ].join("\r\n");

/** What became of a delivery: the reason it was rejected with, if it was. */
interface Delivery {
  rejected: string | undefined;
}

/**
 * Delivers `raw` to `to`, as Email Routing does, on an env with `changes`;
 * `rawSize` is the size the message says it is.
 */
const deliver = async (
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
  await worker.email(message, { ...env, ...changes });
  return delivery;
};

/**
 * How a delivery to the raw-mail ingress is sent: signed with `secret`
 * (core's router secret unless said) for `signed`, which is what's sent
 * unless a test sends something else than it signed.
 */
interface Posting {
  secret?: string;
  signed?: Partial<SignedMail>;
  sent?: Partial<SignedMail>;
  body?: string;
  changes?: Partial<Env>;
  /** Leave the signature out. */
  unsigned?: boolean;
}

/**
 * Posts `raw` for `to` to core's raw-mail ingress, as the router's mail
 * sorter does: through the router-secret check, signed for its recipient,
 * sender, hash, size and time.
 */
const post = async (
  to: string,
  raw: string,
  posting: Posting = {}
): Promise<Response> => {
  const bytes = new TextEncoder().encode(raw);
  const mail: SignedMail = {
    to,
    from: "bounces@acme.test",
    sha256: await sha256HexOfBytes(bytes),
    size: bytes.byteLength,
    sentAt: new Date().toISOString(),
    ...posting.signed,
  };
  const sent = { ...mail, ...posting.sent };
  const signature = await signMail(posting.secret ?? env.ROUTER_SECRET, mail);
  return await worker.fetch(
    new Request(`https://core${mailIngressPath}`, {
      method: "POST",
      headers: {
        [routerSecretHeader]: env.ROUTER_SECRET,
        [mailToHeader]: sent.to,
        [mailFromHeader]: sent.from,
        [mailSha256Header]: sent.sha256,
        [mailSizeHeader]: String(sent.size),
        [mailSentAtHeader]: sent.sentAt,
        ...(posting.unsigned === true
          ? {}
          : { [mailSignatureHeader]: signature }),
      },
      body: posting.body ?? raw,
    }),
    { ...env, ...posting.changes },
    createExecutionContext()
  );
};

/** The App's runs, as its builder sees them. */
const runsOf = async (builder: Person, app: string) =>
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

/**
 * A message's key in the audit log: the App and workflow, and a hash,
 * nothing the message says.
 */
const messageKey = /^email:[\w-]+:intake:[0-9a-f]{64}$/u;

/** What each of the App's runs read of the message it started with. */
const readByRuns = async (builder: Person, app: string) => {
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
const readByRun = async (builder: Person, app: string) => {
  const [read] = await readByRuns(builder, app);
  if (!read) {
    throw new Error(`App ${app} has no run`);
  }
  return read;
};

/** Every object in R2, as its key and when it was stored. */
const storedObjects = async (): Promise<string[]> => {
  const listed = await env.FILES.list({ limit: 1000 });
  return listed.objects.map(
    ({ key, uploaded }) => `${key}@${uploaded.toISOString()}`
  );
};

/** The keys of the objects in R2 that `before` didn't list. */
const addedSince = async (before: readonly string[]): Promise<string[]> => {
  const now = await storedObjects();
  return now
    .filter((object) => !before.includes(object))
    .map((object) => object.split("@")[0] ?? object);
};

/** A kept message's name: its day, and the SHA-256 of its bytes. */
const storedName = /^(?<day>\d{4}-\d{2}-\d{2})\/[0-9a-f]{64}$/u;

describe("email triggers", () => {
  afterEach(endLiveRuns);

  it("start a run with the message as input, and keep it for the App's runs alone", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake());
    const before = await storedObjects();

    const delivery = await deliver("Invoices@grasp.test", invoiceMail());
    const { id, stored, ...read } = await readByRun(builder, app);

    expect(delivery.rejected).toBeUndefined();
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
    expect(read).toMatchObject({
      from: "ben@acme.test",
      subject: "Invoice INV-7",
      text: "Please pay by Friday.\n",
      truncated: false,
      attachments: ["inv-7.pdf:5"],
    });
    // Named by its day and ID, never the App; kept under the App.
    const day = storedName.exec(stored ?? "")?.groups?.day;
    expect(stored).toBe(`${day}/${id}`);
    await expect(addedSince(before)).resolves.toStrictEqual([
      `inbound-email/${day}/${app}/${id}`,
    ]);
  });

  it("show with their workflow, by the address they receive at", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("shown"));

    const { triggers } = await builder.api.workflows.get(app, "intake");

    expect(triggers).toStrictEqual([
      { type: "email", position: 0, address: "shown" },
    ]);
  });

  it("start nothing for mail sent automatically or from the deployment's own domain, and audit each refusal, so a run's mail can't loop back into runs", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("loops"));
    const to = "loops@grasp.test";
    const refused = [
      // An auto-reply to a run's mail, in any of RFC 3834's kinds.
      invoiceMail({
        to,
        subject: "A",
        headers: ["Auto-Submitted: auto-replied"],
      }),
      invoiceMail({
        to,
        subject: "B",
        headers: ["Auto-Submitted: Auto-Generated; owner-email=x@acme.test"],
      }),
      // A run's own mail, sent from the deployment's domain.
      invoiceMail({ to, subject: "C", from: "Robot <robot@GRASP.test>" }),
    ];
    const deliveries = [];
    for (const raw of refused) {
      // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
      deliveries.push(await deliver(to, raw));
    }
    // Its envelope sender at the deployment's domain, whatever its From.
    deliveries.push(
      await deliver(to, invoiceMail({ to, subject: "D" }), {
        envelopeFrom: "bounce-1@grasp.test",
      })
    );
    // A person's mail, saying it wasn't sent automatically.
    const allowed = await deliver(
      to,
      invoiceMail({ to, subject: "E", headers: ["Auto-Submitted: no"] })
    );
    const reads = await readByRuns(builder, app);
    const events = await allEvents();

    expect({
      // Accepted, never bounced: a bounce is mail that can loop too.
      rejected: [...deliveries, allowed].map(({ rejected }) => rejected),
      started: reads.map(({ subject }) => subject),
      refusals: events
        .filter(
          ({ action, target }) =>
            action === "workflow.email.refused" && target?.id === app
        )
        // In the order they were delivered.
        .map(({ detail }) => [detail.address, detail.reason]),
    }).toStrictEqual({
      rejected: [undefined, undefined, undefined, undefined, undefined],
      started: ["E"],
      refusals: [
        ["loops", "auto_submitted"],
        ["loops", "auto_submitted"],
        ["loops", "own_domain"],
        ["loops", "own_domain"],
      ],
    });
  });

  it("keep nothing of a message without attachments, or with inline ones only", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("unkept"));
    const before = await storedObjects();

    await deliver("unkept@grasp.test", unclosed("Plain", "<p>No files.</p>"));
    await deliver("unkept@grasp.test", inlineOnly);

    const read = await readByRuns(builder, app);
    expect(
      read
        .map(({ subject, stored, attachments }) => ({
          subject,
          stored,
          attachments: attachments.length,
        }))
        .toSorted((a, b) => a.subject.localeCompare(b.subject))
    ).toStrictEqual([
      { subject: "Inline", stored: null, attachments: 1 },
      { subject: "Plain", stored: null, attachments: 0 },
    ]);
    await expect(addedSince(before)).resolves.toStrictEqual([]);
  });

  it("start the same message once across a new version of the workflow", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("again"));
    const to = "again@grasp.test";
    const mail = invoiceMail({
      to,
      messageId: `${crypto.randomUUID()}@acme.test`,
    });

    await deliver(to, mail);
    // A new version: its triggers are registered anew.
    await release(builder, app, {
      "workflows/lib/note.ts": "export const note = 2;\n",
    });
    await deliver(to, mail);

    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("pass the text of a message that has only HTML", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("html"));
    const html = [
      "From: Ben <ben@acme.test>",
      "To: html@grasp.test",
      "Subject: HTML",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><p>Pay <b>INV-7</b> &amp; thanks</p><script>steal()</script><p>Ben</p></body></html>",
      "",
    ].join("\r\n");

    await deliver("html@grasp.test", html);

    await expect(readByRun(builder, app)).resolves.toMatchObject({
      text: "Pay INV-7 & thanks\nBen",
    });
  });

  it("read the text of HTML that never closes its tags in time that grows with its length alone", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("unclosed"));
    // Scripts and tags opened and never closed, over 2 MB each: a scan
    // from each to the end, as a lazy pattern does, takes over a minute
    // here; one pass, a few milliseconds.
    const startedAt = performance.now();
    await deliver(
      "unclosed@grasp.test",
      unclosed("scripts", `<p>Pay INV-7</p>${"<script".repeat(300_000)}`)
    );
    await deliver(
      "unclosed@grasp.test",
      unclosed("tags", `<p>Pay INV-7</p>${"<a <b".repeat(500_000)}`)
    );
    const took = performance.now() - startedAt;
    const reads = await readByRuns(builder, app);

    expect(took).toBeLessThan(5000);
    expect(
      Object.fromEntries(
        reads.map(({ subject, text }) => [subject, text.slice(0, 20)])
      )
    ).toStrictEqual({
      // A script that never ends ends the text.
      scripts: "Pay INV-7",
      // A tag that never closes is text, as far as it fits.
      tags: "Pay INV-7\n<a <b<a <b",
    });
  });

  it("start a message's run when delivered again after its start failed, once", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("retried"));
    const mail = invoiceMail({
      to: "retried@grasp.test",
      messageId: `${crypto.randomUUID()}@acme.test`,
    });
    // An ID core's record takes but Workflows refuses (over 100
    // characters), so creating the run fails after its row is written.
    const unstartable: ReturnType<typeof crypto.randomUUID> =
      `run-${"x".repeat(100)}-${crypto.randomUUID()}`;
    const uuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(unstartable);
    let first: string;
    try {
      first = await outcome(deliver("retried@grasp.test", mail));
    } finally {
      uuid.mockRestore();
    }

    const again = await outcome(deliver("retried@grasp.test", mail));
    const third = await outcome(deliver("retried@grasp.test", mail));
    const started = await runsOf(builder, app);
    await Promise.all(
      started
        .filter(({ id }) => id !== unstartable)
        .map(async ({ id }) => {
          await finished(id);
        })
    );
    const runs = await runsOf(builder, app);

    expect({
      first: first === "ok",
      again,
      third,
      runs: runs
        .map(
          ({ id, status }) =>
            `${id === unstartable ? "failed start" : "new"}: ${status}`
        )
        .toSorted(),
    }).toStrictEqual({
      first: false,
      again: "ok",
      third: "ok",
      runs: ["failed start: failed", "new: completed"],
    });
  });

  it("start a workflow once for a message two of its triggers receive", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("doubled", "intake", 2));

    await expect(
      outcome(
        deliver("doubled@grasp.test", invoiceMail({ to: "doubled@grasp.test" }))
      )
    ).resolves.toBe("ok");
    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("keep a < that starts no tag as text", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("math"));
    const html = [
      "From: Ben <ben@acme.test>",
      "To: math@grasp.test",
      "Subject: Math",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<!DOCTYPE html><p>5 < 10 and 10 > 5</p><p>x <3 y</p>",
      "",
    ].join("\r\n");

    await deliver("math@grasp.test", html);

    await expect(readByRun(builder, app)).resolves.toMatchObject({
      text: "5 < 10 and 10 > 5\nx <3 y",
    });
  });

  it("stop a workflow going over its hourly limit, start the others, and start each run once when the mail comes again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...intake("busy"),
      ...intake("busy", "tally"),
    });
    // The hour's runs from mail, as recorded: `intake` at its 60, `tally`
    // one short, so this message's run is `tally`'s 60th.
    const now = Date.now();
    const hours = [
      ...Array.from({ length: 60 }, (_, index) => ({
        workflow: "intake",
        index,
      })),
      ...Array.from({ length: 59 }, (_, index) => ({
        workflow: "tally",
        index,
      })),
    ].map((run) => ({ ...run, id: crypto.randomUUID() }));
    const seeded = new Set(hours.map(({ id }) => id));
    await env.DB.batch(
      hours.map(({ id, workflow, index }) =>
        env.DB.prepare(
          "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, trigger_key) VALUES (?, ?, ?, 1, NULL, 'completed', ?, ?, ?)"
        ).bind(
          id,
          app,
          workflow,
          now - index * 1000,
          now,
          `email:${app}:${workflow}:${index}`
        )
      )
    );
    const mail = invoiceMail({
      to: "busy@grasp.test",
      messageId: `${crypto.randomUUID()}@acme.test`,
    });
    const started = async () => {
      const runs = await runsOf(builder, app);
      return runs
        .filter(({ id }) => !seeded.has(id))
        .map(({ workflow }) => workflow)
        .toSorted();
    };

    const first = await outcome(deliver("busy@grasp.test", mail));
    const whileCapped = await started();
    // The hour moves on for `intake`; `tally` is at its 60 now, one of
    // them this message's. The sender tries again.
    await env.DB.prepare(
      "UPDATE workflow_runs SET created_at = ? WHERE app_id = ? AND workflow_id = 'intake'"
    )
      .bind(now - 2 * 60 * 60 * 1000, app)
      .run();
    const again = await outcome(deliver("busy@grasp.test", mail));

    expect({
      first: first.includes("over a workflow's hourly limit"),
      whileCapped,
      again,
      afterwards: await started(),
    }).toStrictEqual({
      first: true,
      whileCapped: ["tally"],
      again: "ok",
      afterwards: ["intake", "tally"],
    });
  });

  it("cut text of characters UTF-16 splits in two on a character's edge, to fit", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("emoji"));
    const to = "emoji@grasp.test";
    // Quotes JSON escapes and characters UTF-16 splits in two, shifted by
    // up to five: whatever the size of the rest of the input, at least one
    // of these first cuts falls between the halves of a character, and
    // still fits.
    const texts = Array.from(
      { length: 6 },
      (_, shift) => `${"a".repeat(shift)}${'"😀'.repeat(60_000)}`
    );

    for (const [shift, text] of texts.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
      await deliver(to, invoiceMail({ to, subject: `shift ${shift}`, text }));
    }
    const reads = await readByRuns(builder, app);

    expect(
      reads.map(({ last, truncated, size }) => ({
        whole: last === "😀" || last === '"',
        truncated,
        fits: size <= 128 * 1024,
      }))
    ).toStrictEqual(
      texts.map(() => ({ whole: true, truncated: true, fits: true }))
    );
  });

  it("start one run for a message delivered again, by its Message-ID or else its bytes, and keep it once", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("twice"));
    const messageId = `${crypto.randomUUID()}@acme.test`;
    const to = "twice@grasp.test";
    const before = await storedObjects();

    // Redelivered through another server: new Received header, same ID.
    await deliver(to, invoiceMail({ to, messageId, receivedBy: "mx1" }));
    await deliver(to, invoiceMail({ to, messageId, receivedBy: "mx2" }));
    // Sent again under the same ID with other words each time: the same
    // message still, and nothing more of it is kept.
    for (const text of ["Pay today.", "Pay now.", "Pay at once."]) {
      // oxlint-disable-next-line no-await-in-loop -- one delivery after another
      await deliver(to, invoiceMail({ to, messageId, text }));
    }
    // Without a Message-ID, the same bytes are the same message.
    await deliver(to, invoiceMail({ to, subject: "INV-8" }));
    await deliver(to, invoiceMail({ to, subject: "INV-8" }));
    await deliver(to, invoiceMail({ to, subject: "INV-9" }));
    // An empty Message-ID names no message: two messages with it are two.
    await deliver(to, invoiceMail({ to, subject: "INV-10", messageId: "" }));
    await deliver(to, invoiceMail({ to, subject: "INV-11", messageId: "" }));

    await expect(runsOf(builder, app)).resolves.toHaveLength(5);
    // One kept message a run, however often and however it came again.
    const kept = await addedSince(before);
    const stored = await readByRuns(builder, app);
    expect(kept.toSorted()).toStrictEqual(
      stored
        .map(({ stored: name }) => {
          const [day, id] = (name ?? "").split("/");
          return `inbound-email/${day}/${app}/${id}`;
        })
        .toSorted()
    );
    const events = await allEvents();

    expect(
      events
        .filter(
          ({ action, detail }) =>
            action === "workflow.run.started" && detail.app === app
        )
        .map(({ actor, detail }) => [
          actor.type,
          detail.trigger,
          messageKey.test(String(detail.key)),
        ])
    ).toStrictEqual(Array.from({ length: 5 }, () => ["system", "email", true]));
  });

  it("bounce mail to an address nobody receives at", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("somebody"));
    const mail = invoiceMail({ to: "somebody@grasp.test" });

    const unknown = await deliver("nobody@grasp.test", mail);

    expect(unknown.rejected).toBe("No such address.");
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("bounce a message that can't be read, such as one nested too deep", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("nested"));

    const delivery = await deliver("nested@grasp.test", nestedMail(300));

    expect(delivery.rejected).toBe("The message can't be read.");
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("fit a hostile message into a run's input", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("hostile"));
    const to = Array.from(
      { length: 500 },
      (_, index) => `"${"N".repeat(300)}" <r${index}@acme.test>`
    ).join(", ");

    await deliver(
      "hostile@grasp.test",
      invoiceMail({
        to,
        subject: "S".repeat(5000),
        filename: `${"f".repeat(1000)}.pdf`,
        // Quotes and backslashes take two characters each in JSON.
        text: '"\\'.repeat(200_000),
      })
    );
    const read = await readByRun(builder, app);

    expect({
      to: read.to,
      subject: read.subject.length,
      attachment: read.attachments[0]?.split(":")[0]?.length,
      truncated: read.truncated,
      fits: read.size <= 128 * 1024,
    }).toStrictEqual({
      to: 100,
      subject: 1000,
      attachment: 256,
      truncated: true,
      fits: true,
    });
  });

  it("bounce a message over 10 MiB, whatever size it says it is", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("large"));
    const large = `${invoiceMail()}${"x".repeat(10 * 1024 * 1024)}`;

    const delivery = await deliver("large@grasp.test", large, { rawSize: 1 });

    expect(delivery.rejected).toBe("The message is too large.");
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("say in the audit log which addresses a version receives mail at", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("audited"));
    const events = await allEvents();

    expect(
      events.filter(
        ({ action, target }) =>
          action === "app.version.current" && target?.id === app
      )
    ).toMatchObject([
      { detail: { schedules: 0, emails: "audited", events: "" } },
    ]);
  });

  it("go to one App: another can't take an address that's taken", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("taken"));
    const { id: other } = await builder.api.apps.create({ name: "Other" });

    await expect(
      outcome(release(builder, other, intake("taken")))
    ).resolves.toBe("workflow.email_taken");
    // The App that has it keeps it in its next version.
    await expect(
      outcome(
        release(builder, app, {
          "workflows/lib/note.ts": "export const note = 1;\n",
        })
      )
    ).resolves.toBe("ok");
    await deliver("taken@grasp.test", invoiceMail());
    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("go to one App even when two take an address at once", async () => {
    const builder = await personApi("builder");
    const first = await appWith(builder, intake("inbox"));
    const { id: second } = await builder.api.apps.create({ name: "Second" });
    const { version } = await builder.api.apps.files.commit(
      second,
      intake("raced"),
      "Raced"
    );
    // The first App takes the address just before the second's batch
    // lands: after the second checked it was free.
    const racing = racingDb(
      async (db) =>
        await db
          .prepare(
            "UPDATE workflow_triggers SET address = 'raced' WHERE app_id = ?"
          )
          .bind(first)
          .run()
    );

    const refused = await outcome(
      setCurrentVersion(
        { ...env, DB: racing },
        await builder.api.whoami(),
        second,
        version
      )
    );
    const { results } = await env.DB.prepare(
      "SELECT app_id FROM workflow_triggers WHERE address = 'raced'"
    ).all<{ app_id: string }>();

    expect({
      refused,
      receivers: results.map(({ app_id }) => app_id),
    }).toStrictEqual({
      refused: "app.conflict",
      receivers: [first],
    });
  });
});

/**
 * A workflow receiving mail at `address` that reads the message's first
 * attachment in a step, and returns its name for the message and the
 * attachment's content, as text.
 */
const reader = (address: string): Record<string, string> => ({
  "workflows/reader.ts": `import { emailMessage, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "reader",
  { params: {}, input: emailMessage, triggers: [{ type: "email", address: "${address}" }] },
  async (step, { input, readAttachment }) =>
    await step.do("read", { description: "Read the invoice" }, async () => {
      const pdf = await readAttachment(input, 0);
      return { stored: input.stored, content: String.fromCharCode(...pdf) };
    })
);
`,
  "workflows/reader.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./reader.ts";

const stored = "2026-09-29/${"0".repeat(64)}";
const input = { id: "m", stored, from: { name: "", address: "a@b.test" }, to: [], cc: [], subject: "", date: null, text: "", truncated: false, attachments: [{ filename: "inv.pdf", mimeType: "application/pdf", size: 5 }] };

export default workflowTests(definition, [
  { name: "reads", input, attachments: { [stored]: [new TextEncoder().encode("%PDF-")] }, expect: { output: { stored, content: "%PDF-" } } },
]);
`,
});

/**
 * A workflow started by hand with a kept message's name, which reads its
 * first attachment, as a run of another App would try to.
 */
const snoop: Record<string, string> = {
  "workflows/snoop.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "snoop",
  { params: {}, input: z.object({ stored: z.string() }) },
  async (step, { input, readAttachment }) =>
    await step.do("read", { description: "Read another App's mail" }, async () =>
      (await readAttachment(input, 0)).byteLength
    )
);
`,
  "workflows/snoop.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./snoop.ts";

export default workflowTests(definition, [
  { name: "runs", input: { stored: "x" }, mocks: { read: 0 }, expect: { output: 0 } },
]);
`,
};

/**
 * A workflow started by hand with reads to try: each a kept message's
 * name and an attachment's index, as sent. It catches every refusal, as
 * code probing for what it may read would, and returns their codes.
 */
const probe: Record<string, string> = {
  "workflows/probe.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "probe",
  { params: {}, input: z.object({ reads: z.array(z.object({ stored: z.string(), index: z.number() })) }) },
  async (step, { input, readAttachment }) =>
    await step.do("probe", { description: "Try some reads" }, async () => {
      const codes: string[] = [];
      for (const { stored, index } of input.reads) {
        try {
          await readAttachment({ stored }, index);
          codes.push("read");
        } catch (error) {
          codes.push(String((error as { code?: unknown }).code));
        }
      }
      return codes;
    })
);
`,
  "workflows/probe.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./probe.ts";

export default workflowTests(definition, [
  { name: "runs", input: { reads: [] }, mocks: { probe: [] }, expect: { output: [] } },
]);
`,
};

/** The audit log's reads of kept messages by run `run`. */
const readsBy = async (run: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.email.read" && target?.id === run
    )
    .map(({ actor, detail }) => ({ actor, detail }));
};

describe("attachments of mail", () => {
  afterEach(endLiveRuns);

  it("are read by the run the message started, and each read is audited", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, reader("scans"));

    await deliver("scans@grasp.test", invoiceMail({ to: "scans@grasp.test" }));
    const [run] = await runsOf(builder, app);
    await finished(run?.id ?? "");
    const { output } = await builder.api.workflows.status(run?.id ?? "");
    const read = z
      .object({ stored: z.string(), content: z.string() })
      .parse(output);

    // The PDF as it was sent: its bytes, not what the message said of them.
    expect(read.content).toBe("%PDF-");
    await expect(readsBy(run?.id ?? "")).resolves.toStrictEqual([
      {
        actor: {
          type: "workflow",
          runId: run?.id,
          appId: app,
          workflowId: "reader",
        },
        detail: {
          app,
          workflow: "reader",
          version: 1,
          step: "read",
          message: read.stored,
          attachment: 0,
          bytes: 5,
        },
      },
    ]);
  });

  it("are read by a run whose first delivery stopped while starting it, started once by the delivery that comes again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, reader("restarted"));
    const to = "restarted@grasp.test";
    const messageId = `${crypto.randomUUID()}@acme.test`;
    // The first delivery stops with its run's row written and its start
    // not yet at the engine, as when core goes down there.
    const { promise: stuck, resolve: unstick } = Promise.withResolvers<null>();
    const { promise: asked, resolve: startAsked } =
      Promise.withResolvers<null>();
    let held = false;
    let first: Promise<string> | undefined;
    await aroundEngine(
      async (method, call) => {
        if (method === "start" && !held) {
          held = true;
          startAsked(null);
          await stuck;
        }
        return await call();
      },
      async () => {
        first = outcome(
          deliver(to, invoiceMail({ to, messageId, receivedBy: "mx1" }))
        );
        await asked;
        // Delivered again, through another server: it sends that run's
        // start again, and the run reads the message as the first
        // delivery kept it.
        await deliver(to, invoiceMail({ to, messageId, receivedBy: "mx2" }));
      }
    );
    const [run] = await runsOf(builder, app);
    await finished(run?.id ?? "");
    unstick(null);
    await first;
    const { status, output } = await builder.api.workflows.status(
      run?.id ?? ""
    );

    const runs = await runsOf(builder, app);
    expect({
      runs: runs.length,
      status,
      output,
    }).toMatchObject({
      runs: 1,
      status: "completed",
      output: { content: "%PDF-" },
    });
  });

  it("can't be read by another App's run, which is refused and audited", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, reader("private"));
    const other = await appWith(builder, snoop);
    const before = await storedObjects();

    await deliver(
      "private@grasp.test",
      invoiceMail({ to: "private@grasp.test" })
    );
    const [received] = await runsOf(builder, app);
    await finished(received?.id ?? "");
    const { output } = await builder.api.workflows.status(received?.id ?? "");
    const { stored } = z.object({ stored: z.string() }).parse(output);
    const { id: run } = await builder.api.workflows.start(other, "snoop", {
      stored,
    });
    await finished(run);

    await expect(builder.api.workflows.status(run)).resolves.toMatchObject({
      status: "failed",
      failure: {
        step: "read",
        error: { code: "workflow.attachment_not_found" },
      },
    });
    await expect(readsBy(run)).resolves.toMatchObject([
      {
        detail: {
          app: other,
          message: stored,
          attachment: 0,
          errorCode: "workflow.attachment_not_found",
        },
      },
    ]);
    // It was kept for its own App only.
    await expect(addedSince(before)).resolves.toStrictEqual([
      `inbound-email/${stored.split("/")[0]}/${app}/${stored.split("/")[1]}`,
    ]);
  });

  it("are deleted once 30 days have passed since the day they were kept", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("kept"));
    await deliver("kept@grasp.test", invoiceMail({ to: "kept@grasp.test" }));
    const { id, stored } = await readByRun(builder, app);
    const day = storedName.exec(stored ?? "")?.groups?.day ?? "";
    const key = `inbound-email/${day}/${app}/${id}`;
    const dayEnded = Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000;
    const kept = async (): Promise<boolean> =>
      (await env.FILES.head(key)) !== null;

    // Up to 30 days after its day ended, it stays.
    await runQuarterHourCron(
      {},
      new Date(dayEnded + 30 * 24 * 60 * 60 * 1000 - 1)
    );
    await expect(kept()).resolves.toBeTruthy();
    // Then the next run deletes it.
    await runQuarterHourCron({}, new Date(dayEnded + 30 * 24 * 60 * 60 * 1000));
    await expect(kept()).resolves.toBeFalsy();
  });

  it("refuse, and audit, a read its code catches: a name that isn't one, or an attachment the message hasn't", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, { ...reader("probed"), ...probe });

    await deliver(
      "probed@grasp.test",
      invoiceMail({ to: "probed@grasp.test" })
    );
    const runs = await runsOf(builder, app);
    const received = runs.find(({ workflow }) => workflow === "reader");
    await finished(received?.id ?? "");
    const { output } = await builder.api.workflows.status(received?.id ?? "");
    const { stored } = z.object({ stored: z.string() }).parse(output);
    const [day, id] = stored.split("/");
    const traversal = `${day}/../${app}/${id}`;
    const { id: run } = await builder.api.workflows.start(app, "probe", {
      reads: [
        { stored, index: 5 },
        { stored: traversal, index: 0 },
        { stored, index: 0 },
      ],
    });
    await finished(run);

    await expect(builder.api.workflows.status(run)).resolves.toMatchObject({
      status: "completed",
      output: ["workflow.attachment_not_found", "workflow.invalid", "read"],
    });
    const audited = await readsBy(run);
    const reads = audited.map(({ detail }) => detail);
    expect(reads).toHaveLength(3);
    expect(reads).toStrictEqual(
      expect.arrayContaining([
        {
          app,
          workflow: "probe",
          version: 1,
          step: "probe",
          message: stored,
          attachment: 0,
          bytes: 5,
        },
        {
          app,
          workflow: "probe",
          version: 1,
          step: "probe",
          message: traversal,
          attachment: 0,
          errorCode: "workflow.invalid",
        },
        {
          app,
          workflow: "probe",
          version: 1,
          step: "probe",
          message: stored,
          attachment: 5,
          errorCode: "workflow.attachment_not_found",
        },
      ])
    );
  });
});

/** The time `n` minutes from now, ISO 8601. */
const minutes = (n: number): string =>
  new Date(Date.now() + n * 60_000).toISOString();

describe("mail posted to core's raw-mail ingress", () => {
  afterEach(endLiveRuns);

  it("starts a run as mail from Email Routing does", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("posted"));

    const response = await post("posted@grasp.test", invoiceMail());
    const read = await readByRun(builder, app);

    expect(response.status).toBe(202);
    expect(read).toMatchObject({
      from: "ben@acme.test",
      subject: "Invoice INV-7",
      attachments: ["inv-7.pdf:5"],
    });
  });

  it("answers a bounce with core's reason", async () => {
    const response = await post("nobody-here@grasp.test", invoiceMail());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toStrictEqual({
      reason: "No such address.",
    });
  });

  it("takes the previous router secret's signature only while rotating", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("rotated"));
    const previous = "previous-router-secret";

    const before = await post("rotated@grasp.test", invoiceMail(), {
      secret: previous,
    });
    const rotating = await post("rotated@grasp.test", invoiceMail(), {
      secret: previous,
      changes: { ROUTER_SECRET_PREVIOUS: previous },
    });

    expect([before.status, rotating.status]).toStrictEqual([403, 202]);
    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("refuses a delivery that isn't signed for exactly what it carries, and starts nothing", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("guarded"));
    const to = "guarded@grasp.test";
    const mail = invoiceMail();
    // Same length, other bytes: what a message swapped on the way looks like.
    const swapped = mail.replace("Friday", "Monday");

    const refusals = {
      // The router secret alone: any public request through the router.
      unsigned: await post(to, mail, { unsigned: true }),
      otherKey: await post(to, mail, { secret: "another-client-secret" }),
      // Signed for one address, sent to another.
      otherRecipient: await post("someone-else@grasp.test", mail, {
        sent: { to },
      }),
      otherSender: await post(to, mail, {
        sent: { from: "ceo@acme.test" },
      }),
      otherBody: await post(to, mail, { body: swapped }),
      shorterBody: await post(to, mail, { body: mail.slice(0, -10) }),
      stale: await post(to, mail, {
        signed: { sentAt: minutes(-10) },
      }),
      ahead: await post(to, mail, { signed: { sentAt: minutes(10) } }),
      notConfigured: await post(to, mail, {
        changes: { ROUTER_SECRET: "" },
        secret: "",
      }),
    };

    expect(
      Object.fromEntries(
        Object.entries(refusals).map(([name, response]) => [
          name,
          response.status,
        ])
      )
    ).toStrictEqual(
      Object.fromEntries(Object.keys(refusals).map((name) => [name, 403]))
    );
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });
});
