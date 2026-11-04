import type { Role } from "@grasp-os/shared/roles";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  addedSince,
  deliver,
  invoiceMail,
  messagesOf,
  messageTriggerFor,
  own,
  storedObjects,
} from "./email-triggers.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";

// Email triggers (email-triggers.ts): what of a message reaches the run it
// starts, and which messages are bounced as unreadable or too large.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/** A builder's email trigger at a name made of `prefix`, and its address. */
const triggerAt = async (prefix: string) => {
  const { name, id } = await messageTriggerFor(
    await personApi("builder"),
    prefix
  );
  return { id, to: `${name}@${own}` };
};

/** What the only run trigger `id` started took of its message. */
const messageOf = async (id: string) => {
  const [message] = await messagesOf(id);
  if (message === undefined) {
    throw new Error(`Trigger ${id} started no run`);
  }
  return message;
};

/** An HTML-only message, with `subject` and `body`. */
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

describe("email triggers", () => {
  afterEach(endLiveRuns);

  it("keep nothing of a message without attachments, or with inline ones only", async () => {
    const { id, to } = await triggerAt("unkept");
    const before = await storedObjects();

    await deliver(to, unclosed("Plain", "<p>No files.</p>"));
    await deliver(to, inlineOnly);

    const read = await messagesOf(id);
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

  it("pass the text of a message that has only HTML", async () => {
    const { id, to } = await triggerAt("html");
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

    await deliver(to, html);

    await expect(messageOf(id)).resolves.toMatchObject({
      text: "Pay INV-7 & thanks\nBen",
    });
  });

  it("read the text of HTML that never closes its tags in time that grows with its length alone", async () => {
    const { id, to } = await triggerAt("unclosed");
    // Scripts and tags opened and never closed, over 2 MB each: a scan
    // from each to the end, as a lazy pattern does, takes over a minute
    // here; one pass, a few milliseconds.
    const startedAt = performance.now();
    await deliver(
      to,
      unclosed("scripts", `<p>Pay INV-7</p>${"<script".repeat(300_000)}`)
    );
    await deliver(
      to,
      unclosed("tags", `<p>Pay INV-7</p>${"<a <b".repeat(500_000)}`)
    );
    const took = performance.now() - startedAt;
    const reads = await messagesOf(id);

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

  it("keep a < that starts no tag as text", async () => {
    const { id, to } = await triggerAt("math");
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

    await deliver(to, html);

    await expect(messageOf(id)).resolves.toMatchObject({
      text: "5 < 10 and 10 > 5\nx <3 y",
    });
  });

  it("cut text of characters UTF-16 splits in two on a character's edge, to fit", async () => {
    const { id, to } = await triggerAt("emoji");
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
    const reads = await messagesOf(id);

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

  it("bounce a message that can't be read, such as one nested too deep", async () => {
    const { id, to } = await triggerAt("nested");

    const delivery = await deliver(to, nestedMail(300));

    expect(delivery.rejected).toBe("The message can't be read.");
    await expect(messagesOf(id)).resolves.toHaveLength(0);
  });

  it("fit a hostile message into a run's input", async () => {
    const trigger = await triggerAt("hostile");
    const to = Array.from(
      { length: 500 },
      (_, index) => `"${"N".repeat(300)}" <r${index}@acme.test>`
    ).join(", ");

    await deliver(
      trigger.to,
      invoiceMail({
        to,
        subject: "S".repeat(5000),
        filename: `${"f".repeat(1000)}.pdf`,
        // Quotes and backslashes take two characters each in JSON.
        text: '"\\'.repeat(200_000),
      })
    );
    const read = await messageOf(trigger.id);

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
    const { id, to } = await triggerAt("large");
    const large = `${invoiceMail()}${"x".repeat(10 * 1024 * 1024)}`;

    const delivery = await deliver(to, large, { rawSize: 1 });

    expect(delivery.rejected).toBe("The message is too large.");
    await expect(messagesOf(id)).resolves.toHaveLength(0);
  });
});
