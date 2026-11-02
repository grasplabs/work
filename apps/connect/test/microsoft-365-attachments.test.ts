import { signCapability } from "@grasp-os/shared/capability";
import type { ConnectionPerson, PendingAction } from "@grasp-os/shared/connect";
import { attachmentLimits } from "@grasp-os/shared/connector-attachments";
import type { AttachmentBytes } from "@grasp-os/shared/connector-attachments";
import { toBase64 } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { idempotentCalls, pendingActions } from "../src/db/schema.ts";
import { attach, bytesOf } from "./attachments.ts";
import type { Attached } from "./attachments.ts";
import {
  agentFor,
  auditEvents,
  callAs,
  chatOrigin,
  connectAccount,
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import type { Call } from "./connect.ts";
import { invoices } from "./fixtures/graph.ts";
import { fakeGraph } from "./graph-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { callTool as call, parsedRequests } from "./tool-calls.ts";
import type { Connection } from "./tool-calls.ts";

// A Microsoft 365 write that attaches run files (GRA-887), through
// connect's real call path, with Graph as the outside system. The ways it
// can fail come first: bytes that aren't the files the input names (the
// connector would send a file nobody approved), files given to an action
// that takes none, a held write whose bytes are kept, shown in full or
// accepted again in another form, and content in the audit log, a stored
// answer or a log.

const providers = fakeProviders();
const graph = fakeGraph();
const audit = auditEvents();

const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  return { id, person };
};

const requests = () => parsedRequests(graph.sent);

const writes = () => requests().filter(({ method }) => method !== "GET");

const mailboxPath = `/v1.0/users/${encodeURIComponent(invoices)}`;

const mail = (files: readonly Attached[]) => ({
  mailbox: invoices,
  subject: "Invoice 2026-0041",
  body: "Attached.",
  to: ["billing@northwind.example.org"],
  attachments: files.map(({ entry }) => entry),
});

/** Makes a call as core does for a workflow run: with its files' bytes. */
const send = async (
  connection: Connection,
  files: readonly Attached[],
  key: string,
  action = "mail.send"
) =>
  await call(connection, action, mail(files), {
    resource: invoices,
    idempotencyKey: key,
    attachments: bytesOf(files),
  });

describe("a Microsoft 365 write that attaches files", () => {
  it("hands Graph each file as an inline attachment, named and typed as its entry says, with its content as it is", async () => {
    const connection = await connected();
    const notes = await attach("notes.txt", "text/plain", "Paid in full.");
    const report = await attach("report.json", "application/json", '{"a":1}');
    await send(connection, [notes, report], "run-1:send");
    await send(connection, [report], "run-1:draft", "mail.createDraft");
    const [sent, drafted] = writes();
    expect(sent).toMatchObject({
      method: "POST",
      path: `${mailboxPath}/sendMail`,
      body: {
        message: {
          subject: "Invoice 2026-0041",
          attachments: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: "notes.txt",
              contentType: "text/plain",
              contentBytes: toBase64(notes.bytes),
            },
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: "report.json",
              contentType: "application/json",
              contentBytes: toBase64(report.bytes),
            },
          ],
        },
      },
    });
    expect(drafted).toMatchObject({
      path: `${mailboxPath}/messages`,
      body: {
        attachments: [
          { name: "report.json", contentBytes: toBase64(report.bytes) },
        ],
      },
    });
  });

  it("sends a message without files as it always did, and a file's twin under two names once as a part", async () => {
    const connection = await connected();
    await send(connection, [], "run-1:plain");
    const twin = await attach("a.txt", "text/plain", "same");
    const other = { ...twin, entry: { ...twin.entry, name: "b.txt" } };
    await send(connection, [twin, other], "run-1:twins");
    const [plain, twins] = writes();
    expect(plain?.body).not.toHaveProperty("message.attachments");
    expect(twins).toMatchObject({
      body: {
        message: {
          attachments: [
            { name: "a.txt", contentBytes: toBase64(twin.bytes) },
            { name: "b.txt", contentBytes: toBase64(twin.bytes) },
          ],
        },
      },
    });
  });

  it("is refused, with nothing sent or claimed, for bytes that aren't the files its input names, or files it may not have", async () => {
    const connection = await connected();
    const file = await attach("a.txt", "text/plain", "alpha");
    const other = await attach("b.txt", "text/plain", "beta");
    const wrongContent: AttachmentBytes = {
      [file.entry.sha256]: Uint8Array.from(new TextEncoder().encode("omega")),
    };
    const tooMany = await Promise.all(
      Array.from(
        { length: attachmentLimits.files + 1 },
        async (_, at) =>
          await attach(`f${String(at)}.txt`, "text/plain", `file ${String(at)}`)
      )
    );
    const cases: [
      string,
      string,
      Call["input"],
      AttachmentBytes | undefined,
    ][] = [
      ["mail.send", "no bytes", mail([file]), undefined],
      ["mail.send", "empty bytes", mail([file]), {}],
      ["mail.send", "an extra part", mail([file]), bytesOf([file, other])],
      ["mail.send", "another content", mail([file]), wrongContent],
      [
        "mail.send",
        "another length",
        { ...mail([file]), attachments: [{ ...file.entry, size: 4 }] },
        bytesOf([file]),
      ],
      [
        "mail.send",
        "a path in a name",
        { ...mail([file]), attachments: [{ ...file.entry, name: "../a.txt" }] },
        bytesOf([file]),
      ],
      [
        "mail.send",
        "a run file's reference where its digest goes",
        { ...mail([]), attachments: [{ file: crypto.randomUUID() }] },
        bytesOf([file]),
      ],
      ["mail.send", "too many files", mail(tooMany), bytesOf(tooMany)],
      [
        "mail.send",
        "a file past the largest",
        {
          ...mail([file]),
          attachments: [
            { ...file.entry, size: attachmentLimits.fileBytes + 1 },
          ],
        },
        bytesOf([file]),
      ],
      ["mail.send", "bytes with no files named", mail([]), bytesOf([file])],
      // Files for an action that takes none.
      [
        "mail.move",
        "files for a tool that takes none",
        { mailbox: invoices, message: "m1", destination: "archive" },
        bytesOf([file]),
      ],
    ];
    const outcomes = await Promise.all(
      cases.map(
        async ([action, , input, bytes], at) =>
          await outcome(
            call(connection, action, input, {
              resource: invoices,
              idempotencyKey: `run-2:refused-${String(at)}`,
              ...(bytes === undefined ? {} : { attachments: bytes }),
            })
          )
      )
    );
    expect(outcomes).toStrictEqual(cases.map(() => "connect.invalid"));
    expect(writes()).toStrictEqual([]);
    // Nothing was claimed: the same keys are still free.
    const claimed = await drizzle(env.DB)
      .select()
      .from(idempotentCalls)
      .where(eq(idempotentCalls.connectionId, connection.id));
    expect(claimed).toStrictEqual([]);
  });

  it("is told apart by its files: the same key with other content is another call", async () => {
    const connection = await connected();
    const first = await attach("a.txt", "text/plain", "alpha");
    const second = await attach("a.txt", "text/plain", "beta!");
    await send(connection, [first], "run-4:send");
    await expect(
      outcome(send(connection, [second], "run-4:send"))
    ).resolves.toBe("connect.idempotency_conflict");
    // The same call again is the stored answer: no second send.
    await send(connection, [first], "run-4:send");
    expect(writes()).toHaveLength(1);
  });

  it("keeps no file content of a send whose outcome is unknown, only what the person is shown", async () => {
    const connection = await connected();
    const file = await attach("notes.txt", "text/plain", "Confidential terms");
    graph.loseWriteAnswer();
    await expect(outcome(send(connection, [file], "run-5:lost"))).resolves.toBe(
      "connect.outcome_unknown"
    );
    const rows = await drizzle(env.DB)
      .select()
      .from(idempotentCalls)
      .where(eq(idempotentCalls.connectionId, connection.id));
    const kept = JSON.stringify(rows);
    expect(kept).toContain(file.entry.sha256);
    expect(kept).not.toContain(toBase64(file.bytes));
    expect(kept).not.toContain("Confidential terms");
    expect(JSON.stringify(await audit.events())).not.toContain(
      toBase64(file.bytes)
    );
  });
});

/** The attachments of the message in a `sendMail` request's body. */
const sentAttachmentsOf = (body: unknown) =>
  z
    .object({
      message: z.object({
        attachments: z.array(
          z.object({ name: z.string(), contentBytes: z.string() })
        ),
      }),
    })
    .parse(body).message.attachments;

/** A restricted run's call: connect holds it for its person. */
const hold = async (
  connection: Connection,
  files: readonly Attached[],
  key: string
) =>
  await outcome(
    callAs(
      agentFor(connection.person.userId),
      {
        connectionId: connection.id,
        action: "mail.send",
        input: mail(files),
        resource: invoices,
        idempotencyKey: key,
        attachments: bytesOf(files),
      },
      { restricted: true }
    )
  );

const waiting = async (person: ConnectionPerson): Promise<PendingAction> => {
  const [held, ...others] = await exports.default.listPendingActions(person);
  if (held === undefined || others.length > 0) {
    throw new Error("Expected one held action");
  }
  return held;
};

/** Confirms `held` as core does, with these bytes. */
const confirm = async (
  person: ConnectionPerson,
  held: PendingAction,
  attachments?: AttachmentBytes
) =>
  await exports.default.confirmAction({
    person,
    id: held.id,
    inputHash: held.inputHash,
    ...(attachments === undefined ? {} : { attachments }),
    capability: await signCapability(
      env.CAPABILITY_SIGNING_KEY,
      agentFor(person.userId),
      {
        connectionId: held.connectionId,
        resource: held.resource ?? undefined,
        action: held.action,
        idempotencyKey: held.idempotencyKey,
        origin: chatOrigin,
        decision: { kind: "confirm", pendingActionId: held.id },
        restricted: true,
      }
    ),
  });

describe("a held Microsoft 365 write that attaches files", () => {
  it("is held with its files' digests only, shown to its person by name, type, size and digest, and sent nothing", async () => {
    const connection = await connected();
    const notes = await attach("notes.txt", "text/plain", "Confidential terms");
    const report = await attach("report.json", "application/json", '{"a":1}');
    await expect(hold(connection, [notes, report], "run-6:send")).resolves.toBe(
      "connect.held"
    );
    const held = await waiting(connection.person);
    const rows = await drizzle(env.DB)
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.connectionId, connection.id));
    const kept = JSON.stringify([rows, await audit.events(), held]);
    expect({
      attachments: held.attachments,
      shown: held.description?.fields.find(
        ({ input }) => input === "attachments"
      ),
      complete: held.description?.complete,
      // Connect keeps no content anywhere: not its held row, nor its events.
      keepsDigests: [notes, report].map((file) =>
        kept.includes(file.entry.sha256)
      ),
      keepsContent:
        kept.includes(toBase64(notes.bytes)) ||
        kept.includes(toBase64(report.bytes)) ||
        kept.includes("Confidential terms"),
      sent: writes().length,
    }).toStrictEqual({
      attachments: [notes.entry, report.entry],
      shown: {
        input: "attachments",
        label: "Attachments",
        value: [
          `notes.txt (text/plain, ${String(notes.bytes.length)} bytes, SHA-256 ${notes.entry.sha256})`,
          `report.json (application/json, ${String(report.bytes.length)} bytes, SHA-256 ${report.entry.sha256})`,
        ],
      },
      complete: true,
      keepsDigests: [true, true],
      keepsContent: false,
      sent: 0,
    });
  });

  it("is sent with the files' bytes once confirmed with bytes that are the digests shown, and not before", async () => {
    const connection = await connected();
    const notes = await attach("notes.txt", "text/plain", "Confidential terms");
    await hold(connection, [notes], "run-7:send");
    const held = await waiting(connection.person);
    const other = await attach("notes.txt", "text/plain", "Other terms....");
    const refusals = [
      // None, an extra part, and another file's content under its digest.
      await outcome(confirm(connection.person, held)),
      await outcome(confirm(connection.person, held, bytesOf([notes, other]))),
      await outcome(
        confirm(connection.person, held, { [notes.entry.sha256]: other.bytes })
      ),
      await outcome(confirm(connection.person, held, bytesOf([other]))),
    ];
    // Each leaves it waiting, with nothing sent.
    const stillHeld = await waiting(connection.person);
    const stillWaiting = stillHeld.id === held.id;
    const sentBefore = writes().length;

    await confirm(connection.person, held, bytesOf([notes]));
    const [sent] = writes();
    const sentAttachments = sentAttachmentsOf(sent?.body);
    const again = await outcome(
      confirm(connection.person, held, bytesOf([notes]))
    );
    const left = await drizzle(env.DB)
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.connectionId, connection.id));
    expect({
      refusals,
      stillWaiting,
      sentBefore,
      sent: sentAttachments,
      // Taken once: its row is gone, and a second confirmation finds none.
      again,
      left,
      sentAfter: writes().length,
    }).toStrictEqual({
      refusals: refusals.map(() => "connect.files_changed"),
      stillWaiting: true,
      sentBefore: 0,
      sent: [{ name: "notes.txt", contentBytes: toBase64(notes.bytes) }],
      again: "connect.pending_not_found",
      left: [],
      sentAfter: 1,
    });
  });

  it("takes no bytes for a held write that attaches none", async () => {
    const connection = await connected();
    await hold(connection, [], "run-8:send");
    const held = await waiting(connection.person);
    const stray = await attach("a.txt", "text/plain", "alpha");
    const refused = await outcome(
      confirm(connection.person, held, bytesOf([stray]))
    );
    await confirm(connection.person, held);
    expect({
      attachments: held.attachments,
      refused,
      sent: writes().length,
    }).toStrictEqual({
      attachments: [],
      refused: "connect.files_changed",
      sent: 1,
    });
  });
});
