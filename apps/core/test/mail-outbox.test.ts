import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { MailToQueue } from "../src/mail-outbox.ts";
import { captureMail, setStoreEnv } from "./mail-capture.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { auditedDuring } from "./sign-in.ts";

// The mail outbox (src/mail-outbox.ts), in the onboarding's store, with
// Email Sending stood in for (test/mail-capture.ts). The ways it can fail,
// tried here:
//
// - A mail going twice: queued twice, or delivered twice.
// - A mail lost to a quota or a passing failure.
// - A mail that can never go retried for nothing, or failing unseen: a
//   suppressed recipient, a sender not verified, no sender at all.
// - Someone's link in a log or the audit log, rather than only in their
//   mail.

const minuteMs = 60 * 1000;

/** Someone's link, as their mail has it. */
const linkPattern = new RegExp(`${clientOrigin}/interview#[A-Za-z0-9_-]+`, "u");

/** A store of its own, apart from the deployment's. */
const newStore = () => env.ONBOARDING.getByName(`mail-${crypto.randomUUID()}`);

/** A mail with no link in it. */
const note = (key: string): MailToQueue => ({
  key,
  to: "oli@acme.test",
  about: "oli",
  fill: null,
  mail: {
    subject: "Hello",
    text: "Hello Oli.",
    html: "<p>Hello Oli.</p>",
    replyTo: "ada@acme.test",
    unsubscribe: "mailto:ada@acme.test?subject=Unsubscribe",
    language: "en",
  },
});

/** What the store's log has of mail, oldest first. */
const mailLog = async (store: ReturnType<typeof newStore>) => {
  const { entries } = await store.staffLog({ what: "mail" });
  return entries
    .map(({ what, person }) => ({ what, person: person?.id ?? null }))
    .toReversed();
};

describe("the mail outbox", () => {
  it("sends a mail once, however often it is queued and delivered", async () => {
    const store = newStore();
    const mail = await captureMail(store);
    const first = await store.sendMail(note("note/once"));
    const again = await store.sendMail(note("note/once"));
    await store.deliverMail();
    await store.deliverMail(Date.now() + 60 * minuteMs);
    const once = await store.mailOf("note/once");
    expect({
      first,
      again,
      sent: mail.sent.length,
      state: once?.state,
    }).toStrictEqual({ first: true, again: false, sent: 1, state: "sent" });
    expect(mail.sent[0]).toMatchObject({
      from: { name: "Stephen at Grasp", email: "onboarding@mail.grasp.test" },
      to: "oli@acme.test",
      replyTo: "ada@acme.test",
      text: "Hello Oli.",
      html: "<p>Hello Oli.</p>",
      headers: {
        "List-Unsubscribe": "<mailto:ada@acme.test?subject=Unsubscribe>",
        "Content-Language": "en",
      },
    });
  });

  it("tries a mail again after a quota error, and sends it then", async () => {
    const store = newStore();
    const mail = await captureMail(store, "E_DAILY_LIMIT_EXCEEDED");
    await store.sendMail(note("note/quota"));
    await store.deliverMail();
    const waiting = await store.mailOf("note/quota");
    // Not before its backoff, then once.
    await store.deliverMail(Date.now() + minuteMs);
    const early = mail.tried.length;
    await store.deliverMail(Date.now() + 6 * minuteMs);
    const sent = await store.mailOf("note/quota");
    expect({
      waiting: { state: waiting?.state, reason: waiting?.reason },
      early,
      tried: mail.tried.length,
      sent: mail.sent.length,
      state: sent?.state,
    }).toStrictEqual({
      waiting: { state: "queued", reason: "E_DAILY_LIMIT_EXCEEDED" },
      early: 1,
      tried: 2,
      sent: 1,
      state: "sent",
    });
  });

  it("ends a mail to a suppressed recipient failed, at once, and puts it in the log", async () => {
    const store = newStore();
    const mail = await captureMail(
      store,
      "E_RECIPIENT_SUPPRESSED",
      "E_SENDER_NOT_VERIFIED"
    );
    await store.sendMail(note("note/suppressed"));
    await store.sendMail({ ...note("note/unverified"), about: null });
    await store.deliverMail();
    await store.deliverMail(Date.now() + 24 * 60 * minuteMs);
    const suppressed = await store.mailOf("note/suppressed");
    const unverified = await store.mailOf("note/unverified");
    expect({
      tried: mail.tried.length,
      sent: mail.sent.length,
      suppressed: [suppressed?.state, suppressed?.reason],
      unverified: [unverified?.state, unverified?.reason],
      log: await mailLog(store),
    }).toStrictEqual({
      tried: 2,
      sent: 0,
      suppressed: ["failed", "E_RECIPIENT_SUPPRESSED"],
      unverified: ["failed", "E_SENDER_NOT_VERIFIED"],
      // Oli isn't on this store's roster, so the log names nobody.
      log: [
        { what: "mail.note.failed.recipient_suppressed", person: null },
        { what: "mail.note.failed.sender_not_verified", person: null },
      ],
    });
  });

  it("sends nothing, and says why, with no sender or nobody to send from", async () => {
    const store = newStore();
    const was = await setStoreEnv(store, {
      EMAIL: undefined,
      MAIL_FROM: env.MAIL_FROM,
    });
    try {
      await store.sendMail(note("note/no-sender"));
      await store.deliverMail();
      await setStoreEnv(store, { MAIL_FROM: undefined });
      await captureMail(store);
      await store.sendMail(note("note/no-from"));
      await store.deliverMail();
    } finally {
      await setStoreEnv(store, was);
    }
    const noSender = await store.mailOf("note/no-sender");
    const noFrom = await store.mailOf("note/no-from");
    const log = await mailLog(store);
    expect({
      noSender: noSender?.reason,
      noFrom: noFrom?.reason,
      log: log.map(({ what }) => what),
    }).toStrictEqual({
      noSender: "mail.no_sender",
      noFrom: "mail.no_from",
      log: ["mail.note.failed.no_sender", "mail.note.failed.no_from"],
    });
  });

  it("puts someone's link in their mail only: never in the logs or the audit log", async () => {
    const store = newStore();
    const by = { type: "system" } as const;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await store.saveRoster(
      {
        teams: [{ id: "ops", name: "Ops", lead: null, does: "", off: false }],
        people: [
          {
            id: "oli",
            name: "Oli",
            email: "oli@acme.test",
            team: "ops",
            title: "",
            away: false,
          },
        ],
      },
      by
    );
    await store.savePlan({ start: yesterday.slice(0, 10), days: 14 }, by);
    await store.setAgreements(
      { processing: true, assessment: true, council: "none" },
      by
    );
    const mail = await captureMail(store, "E_RATE_LIMIT_EXCEEDED");
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    // Their link goes out by email: refused at first, then sent.
    const audited = await auditedDuring(async () => {
      await store.releaseDue(yesterday);
      await store.deliverMail();
      await store.deliverMail(Date.now() + 6 * minuteMs);
    });
    const [sent] = mail.sent;
    const link = linkPattern.exec(sent?.text ?? "")?.[0] ?? "";
    const secret = link.split("#")[1] ?? "";
    const logs = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
    expect({
      link: link.startsWith(`${clientOrigin}/interview#`),
      secret: secret.length,
      html: sent?.html?.includes(`<a href="${link}">`),
      inLogs: logs.includes(secret),
      inAudit: JSON.stringify(audited).includes(secret),
      // The retry was logged: the logs were looked at, not empty.
      retried: logs.includes("mail.retry"),
      log: await mailLog(store),
    }).toStrictEqual({
      link: true,
      secret: 43,
      html: true,
      inLogs: false,
      inAudit: false,
      retried: true,
      log: [{ what: "mail.link.sent", person: "oli" }],
    });
  });
});
