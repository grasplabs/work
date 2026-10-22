import { toBase64 } from "@grasp-os/shared/encoding";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { attach, bytesOf } from "./attachments.ts";
import type { Attached } from "./attachments.ts";
import { connectAccount, outcome, ownAccount, someone } from "./connect.ts";
import { invoices } from "./fixtures/google.ts";
import { fakeGoogle } from "./google-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { callTool as call, parsedRequests } from "./tool-calls.ts";
import type { Connection } from "./tool-calls.ts";

// A Gmail write that attaches run files (GRA-887), through connect's real
// call path, with Google as the outside system: the message Gmail is given
// is a multipart message whose parts are the files as they are, and no
// name or type a caller wrote can add a header, a parameter or a part.

const providers = fakeProviders();
const google = fakeGoogle();

const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(
    providers,
    person,
    ownAccount(person, "google")
  );
  return { id, person };
};

const writes = () =>
  parsedRequests(google.sent).filter(({ method }) => method !== "GET");

const mail = (files: readonly Attached[]) => ({
  mailbox: invoices,
  subject: "Invoice 2026-0041",
  body: "Attached.",
  to: ["billing@northwind.example.org"],
  attachments: files.map(({ entry }) => entry),
});

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

/** The raw message of a Gmail write, decoded. */
const rawOf = (body: unknown): string => {
  const { raw } = z
    .union([
      z.object({ raw: z.string() }),
      z
        .object({ message: z.object({ raw: z.string() }) })
        .transform(({ message }) => message),
    ])
    .parse(body);
  return atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
};

/** A message's parts: each part's header lines, and its body. */
const partsOf = (mime: string) => {
  const boundary = /boundary="(?<boundary>[^"]+)"/u.exec(mime)?.groups
    ?.boundary;
  if (boundary === undefined) {
    throw new Error("Expected a multipart message");
  }
  const [head = "", ...rest] = mime.split(`--${boundary}`);
  const parts = rest.slice(0, -1).map((part) => {
    const [headers = "", ...body] = part
      .replace(/^\r\n/u, "")
      .split("\r\n\r\n");
    return {
      headers: headers.split("\r\n"),
      body: body.join("\r\n\r\n").replaceAll("\r\n", ""),
    };
  });
  return { head, parts, closed: rest.at(-1)?.startsWith("--") ?? false };
};

describe("a Gmail write that attaches files", () => {
  it("is given to Gmail as a multipart message: the body, then each file as it is, named and typed as its entry says", async () => {
    const connection = await connected();
    const notes = await attach("notes.txt", "text/plain", "Paid in full.");
    const report = await attach("report.json", "application/json", '{"a":1}');
    await send(connection, [notes, report], "run-1:send");
    await send(connection, [report], "run-1:draft", "mail.createDraft");
    const [sent, drafted] = writes();
    const message = partsOf(rawOf(sent?.body));
    expect({
      head: message.head
        .split("\r\n")
        .filter((line) => line !== "" && !line.startsWith(" "))
        .map((line) => line.split(":")[0]),
      parts: message.parts.map(({ headers, body }) => ({
        headers: headers.map((line) => line.split(":")[0]),
        type: headers[0],
        body,
      })),
      closed: message.closed,
      drafted: partsOf(rawOf(drafted?.body)).parts.map(
        ({ headers }) => headers[0]
      ),
    }).toStrictEqual({
      head: ["From", "To", "Subject", "MIME-Version", "Content-Type"],
      parts: [
        {
          headers: ["Content-Type", "Content-Transfer-Encoding"],
          type: 'Content-Type: text/plain; charset="UTF-8"',
          body: toBase64(new TextEncoder().encode("Attached.")),
        },
        {
          headers: [
            "Content-Type",
            "Content-Disposition",
            "Content-Transfer-Encoding",
          ],
          type: "Content-Type: text/plain",
          body: toBase64(notes.bytes),
        },
        {
          headers: [
            "Content-Type",
            "Content-Disposition",
            "Content-Transfer-Encoding",
          ],
          type: "Content-Type: application/json",
          body: toBase64(report.bytes),
        },
      ],
      closed: true,
      drafted: [
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Type: application/json",
      ],
    });
  });

  it("keeps a name from adding a header or a parameter: quotes, semicolons and non-ASCII are encoded", async () => {
    const connection = await connected();
    const tricky = await attach(
      'Q4 "final"; x="y" é.txt',
      "text/plain",
      "numbers"
    );
    await send(connection, [tricky], "run-2:send");
    const [sent] = writes();
    const [, file] = partsOf(rawOf(sent?.body)).parts;
    expect(file?.headers).toStrictEqual([
      "Content-Type: text/plain",
      `Content-Disposition: attachment; filename="Q4 _final__ x__y_ _.txt"; filename*=UTF-8''Q4%20%22final%22%3B%20x%3D%22y%22%20%C3%A9.txt`,
      "Content-Transfer-Encoding: base64",
    ]);
  });

  it("is refused, with nothing sent, for bytes that aren't the files its input names", async () => {
    const connection = await connected();
    const file = await attach("a.txt", "text/plain", "alpha");
    const other = await attach("b.txt", "text/plain", "beta");
    const outcomes = [
      await outcome(
        call(connection, "mail.send", mail([file]), {
          resource: invoices,
          idempotencyKey: "run-3:none",
        })
      ),
      await outcome(
        call(connection, "mail.send", mail([file]), {
          resource: invoices,
          idempotencyKey: "run-3:extra",
          attachments: bytesOf([file, other]),
        })
      ),
      await outcome(
        call(connection, "mail.send", mail([file]), {
          resource: invoices,
          idempotencyKey: "run-3:other",
          attachments: { [file.entry.sha256]: other.bytes },
        })
      ),
    ];
    expect({ outcomes, sent: writes().length }).toStrictEqual({
      outcomes: outcomes.map(() => "connect.invalid"),
      sent: 0,
    });
  });
});
