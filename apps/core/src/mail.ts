import { deploymentConfig } from "@grasp-os/shared/config";
import { mailFromSchema } from "@grasp-os/shared/deployment-config";
import type { MailFrom } from "@grasp-os/shared/deployment-config";

// Sending one email, as the mail outbox (mail-outbox.ts) hands it over:
// from `MAIL_FROM`, through the `EMAIL` binding. The binding is the adapter
// interface, as core's R2 bindings are (on-prem/r2.ts): on Cloudflare it is
// Email Sending's `send_email`; on-prem it can be bound to a service of its
// own that takes the same message and sends it another way. Where it is
// unbound, as on plain workerd, or `MAIL_FROM` is unset, nothing is sent and
// the mail fails with the reason: never silently.
//
// What Email Sending answers, sorted here: a quota or a passing failure is
// tried again later (`retry`); anything else ends the mail (`failed`), a
// suppressed recipient and an unverified sender among them, with the code
// as the reason. Neither the mail's words nor its recipient are logged
// here: a mail can carry someone's interview link.

/** One email, as it goes out: its words are already filled in. */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Where a reply goes, when not to `MAIL_FROM`. */
  replyTo?: string;
  /** A `mailto:` or `https:` address that stops these mails (`List-Unsubscribe`). */
  unsubscribe?: string;
  /** The mail's language (`Content-Language`). */
  language?: string;
}

/** What sends mail: the `EMAIL` binding's `send`, or on-prem's own. */
export interface MailTransport {
  send: (message: EmailMessageBuilder) => Promise<EmailSendResult>;
}

/** What became of one try at sending. */
export type SendOutcome =
  | { outcome: "sent"; messageId: string }
  | { outcome: "retry"; reason: string }
  | { outcome: "failed"; reason: string };

/** Nothing sends mail here: no `EMAIL` bound. */
export const noSender = "mail.no_sender";
/** Nobody to send it from: `MAIL_FROM` unset, or not one core takes. */
export const noFrom = "mail.no_from";

/**
 * Email Sending's codes worth trying again: its quotas, which free up
 * later, and its own passing failures. A daily quota takes up to a day,
 * which the outbox's backoff covers.
 */
const retryable: ReadonlySet<string> = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_DELIVERY_FAILED",
]);

/** The `E_…` code of an error Email Sending threw, if it has one. */
const codeOf = (error: unknown): string | undefined => {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" && /^E_[A-Z_]+$/u.test(code)
    ? code
    : undefined;
};

/** Who the deployment's mail is from (`MAIL_FROM`); undefined while unset. */
export const mailFrom = (env: Pick<Env, "MAIL_FROM">): MailFrom | undefined =>
  deploymentConfig(mailFromSchema, "MAIL_FROM", env.MAIL_FROM);

/** The deployment's mail sender, or undefined where nothing is bound. */
const transportOf = (
  env: Partial<Pick<Env, "EMAIL">>
): MailTransport | undefined => env.EMAIL;

/**
 * Sends `mail` once, and says what became of it. Throws nothing: what the
 * binding threw is sorted into `retry` or `failed`, and an error without
 * Email Sending's code (the binding unreachable, say) is tried again.
 */
export const sendMail = async (
  env: Partial<Pick<Env, "EMAIL">> & Pick<Env, "MAIL_FROM">,
  mail: OutgoingMail
): Promise<SendOutcome> => {
  const transport = transportOf(env);
  if (transport === undefined) {
    return { outcome: "failed", reason: noSender };
  }
  const from = mailFrom(env);
  if (from === undefined) {
    return { outcome: "failed", reason: noFrom };
  }
  const headers: Record<string, string> = {};
  if (mail.unsubscribe !== undefined) {
    headers["List-Unsubscribe"] = `<${mail.unsubscribe}>`;
  }
  if (mail.language !== undefined) {
    headers["Content-Language"] = mail.language;
  }
  try {
    const { messageId } = await transport.send({
      from: { name: from.name, email: from.address },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
      headers,
    });
    return { outcome: "sent", messageId };
  } catch (error) {
    const code = codeOf(error);
    if (code === undefined) {
      return { outcome: "retry", reason: "mail.unreachable" };
    }
    return retryable.has(code)
      ? { outcome: "retry", reason: code }
      : { outcome: "failed", reason: code };
  }
};
