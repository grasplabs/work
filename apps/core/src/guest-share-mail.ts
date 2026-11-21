import { log } from "@grasp-os/shared/log";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { signInConfig } from "./auth/config.ts";
import { guestNow } from "./auth/membership-sql.ts";
import { users } from "./db/core/schema.ts";
import { escapeHtml } from "./mail-outbox.ts";
import { sendMail } from "./mail.ts";
import { readOrganization } from "./organization.ts";

// A guest (GRA-2235) has no other way to learn an App was shared with
// them: no chat, no notifications, no Teams or Slack. So each new share
// with a guest mails them once (app-members.ts `addMember`), after it is
// stored: the company's name, the App's name and where to sign in, and
// nothing of the App. English, as the code mail is (auth/guest-codes.ts):
// a guest's language is unknown. A mail that doesn't go is logged by IDs
// and its reason, and the share stands: the guest can still sign in.

/** The mail telling `to` that `company` shared `app` with them. */
const sharedMail = (
  to: string,
  { company, app, signIn }: { company: string; app: string; signIn: string }
) => {
  const who = company === "" ? "Someone" : company;
  const text = `${who} shared the App "${app}" with you as a guest in Grasp.\n\nTo open it, sign in at ${signIn} with this address: choose "Invited as a guest? Sign in with a code", and we'll mail you a code.`;
  const html = `<p>${escapeHtml(who)} shared the App “${escapeHtml(app)}” with you as a guest in Grasp.</p><p>To open it, sign in at <a href="${escapeHtml(signIn)}">${escapeHtml(signIn)}</a> with this address: choose “Invited as a guest? Sign in with a code”, and we'll mail you a code.</p>`;
  return {
    to,
    subject: `${app} was shared with you in Grasp`,
    text,
    html,
    language: "en",
  };
};

/**
 * Mails the guest `userId` that `app` was shared with them, while they are
 * a guest now. Throws nothing.
 */
export const mailGuestShared = async (
  env: Env,
  userId: string,
  app: { id: string; name: string }
): Promise<void> => {
  const origin = signInConfig(env)?.origin;
  const [guest] = await drizzle(env.DB)
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), guestNow(users.id)));
  if (origin === undefined || guest === undefined) {
    return;
  }
  const { name: company } = await readOrganization(env);
  const sent = await sendMail(
    env,
    sharedMail(guest.email, {
      company,
      app: app.name,
      signIn: `${origin}/sign-in`,
    })
  );
  if (sent.outcome !== "sent") {
    log.warn("guest.share_mail_failed", {
      app: app.id,
      guest: userId,
      reason: sent.reason,
    });
  }
};
