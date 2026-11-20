import { guestRole } from "@grasp-os/shared/roles";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { authFor } from "../src/auth/auth.ts";
import { signInConfig } from "../src/auth/config.ts";
import {
  guestCodeDigits,
  guestCodeLifetimeS,
  guestCodePath,
  guestCodeTries,
  guestCodesPerHour,
  guestSignInPath,
} from "../src/auth/guest-codes.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { captureMail } from "./mail-capture.ts";
import type { CapturedMail } from "./mail-capture.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  outcome,
  routed,
  sessionCookieName,
  signedInApi,
  unique,
  whoami,
} from "./sign-in.ts";

// Guests (GRA-2235, pull request 2): an admin or a builder invites an
// address as a guest, and the guest signs in with a code mailed to them
// (auth/guest-codes.ts). From the threat model on the issue, tried here:
//
// - Inviting an address that is the company's, Grasp's, someone removed or
//   erased, or inviting without building.
// - Asking for a code to find out who is invited: the same answer, and
//   nothing stored or sent, for an address that is no guest's.
// - A code signing in a member, or making a user.
// - Mail bombing and guessing: the hour's limit per address, the tries
//   and the life of a code.
// - Access outliving its reason: removing a guest.
// - A guest's session reaching anything: nothing but their own session,
//   on every route of sign-in core serves.

const idp = mockIdp();

/** An address outside the company, no other test's. */
const outsider = (): string => `guest-${unique()}@partner.test`;

/** Captures what core mails from now on. */
const mailbox = async (): Promise<CapturedMail> =>
  await captureMail(onboardingStore(env));

const toOf = (message: EmailMessageBuilder): string => {
  const [to] = [message.to].flat();
  return typeof to === "string" ? to : (to?.email ?? "");
};

/** The mails sent so far to `address`. */
const mailsTo = (mail: CapturedMail, address: string): EmailMessageBuilder[] =>
  mail.sent.filter((message) => toOf(message) === address);

/** The code in the last mail to `address`. */
const codeIn = (mail: CapturedMail, address: string): string => {
  const text = mailsTo(mail, address).at(-1)?.text ?? "";
  const found = /(?<code>\d{4} \d{4})/u.exec(text)?.groups?.code;
  if (found === undefined) {
    throw new Error("No code went to them");
  }
  return found.replace(" ", "");
};

/** A code that isn't `code`, of the same length. */
const otherCode = (code: string): string =>
  String((Number(code) + 1) % 10 ** guestCodeDigits).padStart(
    guestCodeDigits,
    "0"
  );

/**
 * Asks for a code for `email` as the sign-in page does, and waits for
 * what core does after answering: the status and body it answered.
 */
const askCode = async (email: string) => {
  const ctx = createExecutionContext();
  const response = await routed(
    `/api/auth${guestCodePath}`,
    {
      method: "POST",
      headers: { origin: clientOrigin, "content-type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    },
    env,
    ctx
  );
  const answer = { status: response.status, body: await response.text() };
  await waitOnExecutionContext(ctx);
  return answer;
};

/** Signs in with `otp`: the session cookie, or what refused it. */
const codeSignIn = async (
  email: string,
  otp: string
): Promise<{ session?: string; refused?: string }> => {
  const response = await routed(`/api/auth${guestSignInPath}`, {
    method: "POST",
    headers: { origin: clientOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email, otp }),
  });
  const session = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .find(
      (pair) => pair.startsWith(`${sessionCookieName}=`) && !pair.endsWith("=")
    );
  if (session !== undefined) {
    return { session };
  }
  return { refused: `${response.status} ${await response.text()}` };
};

/** How every sign-in with a code that signs nobody in is answered. */
const refused = {
  refused: `400 ${JSON.stringify({ code: "INVALID_OTP", message: "Invalid OTP" })}`,
};

/** A code made for `email` by the plugin itself, as an attacker would want one. */
const plantedCode = async (email: string): Promise<string> => {
  const auth = await authFor(env, signInConfig(env));
  if (auth === undefined) {
    throw new Error("Sign-in isn't configured");
  }
  return await auth.api.createVerificationOTP({
    body: { email, type: "sign-in" },
  });
};

/** How many rows of Better Auth's short-lived values name `email`. */
const storedFor = async (email: string): Promise<number> =>
  (await env.DB.prepare(
    "SELECT count(*) AS n FROM verifications WHERE identifier LIKE ?"
  )
    .bind(`%${email}`)
    .first<number>("n")) ?? 0;

/** Users under `email`, and their accounts. */
const heldBy = async (email: string) => ({
  users:
    (await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email = ?")
      .bind(email)
      .first<number>("n")) ?? 0,
  accounts:
    (await env.DB.prepare(
      "SELECT count(*) AS n FROM accounts JOIN users ON users.id = accounts.user_id WHERE users.email = ?"
    )
      .bind(email)
      .first<number>("n")) ?? 0,
});

const sessionSchema = z.object({
  session: z.object({ guest: z.boolean() }).loose(),
  user: z.object({ email: z.string() }).loose(),
});

/** What `GET /get-session` answers the browser holding `cookie`. */
const sessionOf = async (cookie: string): Promise<unknown> => {
  const response = await routed("/api/auth/get-session", {
    headers: { origin: clientOrigin, cookie },
  });
  return await response.json();
};

/** An admin, and `address` invited as a guest by them. */
const invited = async (address = outsider()) => {
  const admin = await signedInApi(idp, "admin");
  const { userId } = await admin.api.members.inviteGuest(address);
  return { admin, address, userId };
};

/** A guest invited, mailed a code and signed in with it. */
const signedInGuest = async () => {
  const mail = await mailbox();
  const guest = await invited();
  await askCode(guest.address);
  const signedIn = await codeSignIn(guest.address, codeIn(mail, guest.address));
  if (signedIn.session === undefined) {
    throw new Error(`The guest wasn't signed in: ${signedIn.refused}`);
  }
  return { ...guest, mail, cookie: signedIn.session };
};

describe("inviting a guest", () => {
  it("makes an outsider a guest, for an admin or a builder, audited by ID alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");
    const address = outsider();
    let made = "";
    const events = await auditedDuring(async () => {
      ({ userId: made } = await builder.api.members.inviteGuest(
        ` ${address.toUpperCase()} `
      ));
    });
    const again = await auditedDuring(async () => {
      await expect(
        admin.api.members.inviteGuest(address)
      ).resolves.toStrictEqual({
        userId: made,
      });
    });

    const guests = await admin.api.members.guests();
    const listedMembers = await admin.api.members.list();

    expect({
      byUser: await outcome(user.api.members.inviteGuest(outsider())),
      invited: events.map(({ action, target, actor }) => ({
        action,
        target,
        actor: actor.type === "person" ? actor.userId : actor.type,
      })),
      address: JSON.stringify(events).includes(address),
      againEvents: again.length,
      role: await env.DB.prepare("SELECT role FROM members WHERE user_id = ?")
        .bind(made)
        .first<string>("role"),
      listed: guests.filter(({ userId }) => userId === made),
      notAMember: listedMembers.some(({ userId }) => userId === made),
    }).toMatchObject({
      byUser: "role.forbidden",
      invited: [
        {
          action: "member.guest_invited",
          target: { type: "user", id: made },
          actor: builder.userId,
        },
      ],
      address: false,
      againEvents: 0,
      role: guestRole,
      listed: [{ userId: made, email: address }],
      notAMember: false,
    });
  });

  it("refuses an address of the company's, of Grasp's, or someone removed or erased", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const removed = await invited();
    await admin.api.members.remove(removed.userId);
    const erased = await invited();
    await admin.api.members.remove(erased.userId);
    await admin.api.members.erase(erased.userId, erased.address);
    const erasedHeld = await heldBy(erased.address);

    expect({
      member: await outcome(
        admin.api.members.inviteGuest(String(member.person.email))
      ),
      companyDomain: await outcome(
        admin.api.members.inviteGuest(`new-${unique()}@acme.test`)
      ),
      staff: await outcome(
        admin.api.members.inviteGuest(`staff-${unique()}@grasp.test`)
      ),
      removed: await outcome(admin.api.members.inviteGuest(removed.address)),
      erasedHeld: erasedHeld.users,
      erased: await outcome(admin.api.members.inviteGuest(erased.address)),
      notAnAddress: await outcome(admin.api.members.inviteGuest("someone")),
    }).toStrictEqual({
      member: "member.guest_refused",
      companyDomain: "member.guest_refused",
      staff: "member.guest_refused",
      removed: "member.invite_removed",
      erasedHeld: 0,
      erased: "member.invite_removed",
      notAnAddress: "member.guest_email",
    });
  });
});

describe("a guest signing in with a code", () => {
  it("is mailed a short-lived code that signs them in to a session reaching nothing, audited", async () => {
    const mail = await mailbox();
    const { address, userId } = await invited();
    let cookie = "";
    const events = await auditedDuring(async () => {
      await askCode(address);
      const code = codeIn(mail, address);
      expect(code).toHaveLength(guestCodeDigits);
      const signedIn = await codeSignIn(address, code);
      cookie = signedIn.session ?? "";
    });

    expect({
      signedIn: cookie !== "",
      rpc: await outcome(whoami(cookie)),
      session: sessionSchema.parse(await sessionOf(cookie)),
      events: events
        .filter(({ action }) => action.startsWith("member.guest"))
        .map(({ action, actor }) => ({
          action,
          by: actor.type === "person" ? actor.userId : actor.type,
        })),
      address: JSON.stringify(events).includes(address),
    }).toMatchObject({
      signedIn: true,
      rpc: "auth.unauthenticated",
      session: { session: { guest: true }, user: { email: address } },
      events: [
        { action: "member.guest_code_sent", by: userId },
        { action: "member.guest_signed_in", by: userId },
      ],
      address: false,
    });
  });

  it("answers asking for a code exactly alike for anyone, and stores and sends nothing for who is no guest", async () => {
    const mail = await mailbox();
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const memberEmail = String(member.person.email).toLowerCase();
    const guest = await invited();
    const removed = await invited();
    await admin.api.members.remove(removed.userId);
    const nobody = outsider();

    const answers = {
      guest: await askCode(guest.address),
      member: await askCode(memberEmail),
      removed: await askCode(removed.address),
      nobody: await askCode(nobody),
      notAnAddress: await askCode("someone"),
    };

    expect({
      alike: new Set(Object.values(answers).map((a) => JSON.stringify(a))).size,
      answer: answers.guest,
      mailed: [memberEmail, removed.address, nobody].map(
        (email) => mailsTo(mail, email).length
      ),
      stored: [
        await storedFor(memberEmail),
        await storedFor(removed.address),
        await storedFor(nobody),
      ],
      guestMailed: mailsTo(mail, guest.address).length,
    }).toStrictEqual({
      alike: 1,
      answer: { status: 200, body: JSON.stringify({ success: true }) },
      mailed: [0, 0, 0],
      stored: [0, 0, 0],
      guestMailed: 1,
    });
  });

  it("never signs in a member, nor makes a user, whatever code is used", async () => {
    const member = await signedInApi(idp, "user");
    const memberEmail = String(member.person.email).toLowerCase();
    const nobody = outsider();
    const memberHeld = await heldBy(memberEmail);
    const forMember = await plantedCode(memberEmail);
    const forNobody = await plantedCode(nobody);

    expect({
      member: await codeSignIn(memberEmail, forMember),
      nobody: await codeSignIn(nobody, forNobody),
      memberHeld: await heldBy(memberEmail),
      nobodyHeld: await heldBy(nobody),
    }).toStrictEqual({
      member: refused,
      nobody: refused,
      memberHeld,
      nobodyHeld: { users: 0, accounts: 0 },
    });
  });

  it("sends one address at most the hour's codes", async () => {
    const mail = await mailbox();
    const { address } = await invited();
    const other = await invited();
    for (let ask = 0; ask <= guestCodesPerHour; ask += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one ask after another
      await askCode(address);
    }
    await askCode(other.address);

    expect({
      mailed: mailsTo(mail, address).length,
      other: mailsTo(mail, other.address).length,
    }).toStrictEqual({ mailed: guestCodesPerHour, other: 1 });
  });

  it("takes few tries per code, works only for a short time, and only the newest, refusing each exactly as an address that is no guest's", async () => {
    const mail = await mailbox();
    const tried = await invited();
    await askCode(tried.address);
    const triedCode = codeIn(mail, tried.address);
    const wrong = [];
    for (let attempt = 0; attempt < guestCodeTries; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one try after another
      wrong.push(await codeSignIn(tried.address, otherCode(triedCode)));
    }
    const usedUp = await codeSignIn(tried.address, triedCode);

    const replaced = await invited();
    await askCode(replaced.address);
    const first = codeIn(mail, replaced.address);
    await askCode(replaced.address);
    const replacedFirst = await codeSignIn(replaced.address, first);

    const noCode = await invited();
    const withoutCode = await codeSignIn(noCode.address, "12345678");
    const nobody = await codeSignIn(outsider(), "12345678");

    const late = await invited();
    await askCode(late.address);
    const lateCode = codeIn(mail, late.address);
    vi.useFakeTimers({ now: Date.now() + (guestCodeLifetimeS + 1) * 1000 });
    let expired: Awaited<ReturnType<typeof codeSignIn>>;
    try {
      expired = await codeSignIn(late.address, lateCode);
    } finally {
      vi.useRealTimers();
    }

    expect({
      wrong,
      usedUp,
      replacedFirst,
      expired,
      withoutCode,
      nobody,
    }).toStrictEqual({
      wrong: Array.from({ length: guestCodeTries }, () => refused),
      usedUp: refused,
      replacedFirst: refused,
      expired: refused,
      withoutCode: refused,
      nobody: refused,
    });
  });

  it("ends a guest's sessions and outstanding codes once an admin removes them, and leaves no row naming them once erased", async () => {
    const guest = await signedInGuest();
    await askCode(guest.address);
    const outstanding = codeIn(guest.mail, guest.address);
    const storedBefore = await storedFor(guest.address);
    await guest.admin.api.members.remove(guest.userId);
    const guests = await guest.admin.api.members.guests();
    const storedRemoved = await storedFor(guest.address);
    const code = await codeSignIn(guest.address, outstanding);
    await guest.admin.api.members.erase(guest.userId, guest.address);

    expect({
      session: await sessionOf(guest.cookie),
      code,
      listed: guests.some(({ userId }) => userId === guest.userId),
      storedBefore,
      storedRemoved,
      storedErased: await storedFor(guest.address),
      held: await heldBy(guest.address),
    }).toStrictEqual({
      session: null,
      code: refused,
      listed: false,
      storedBefore: 1,
      storedRemoved: 0,
      storedErased: 0,
      held: { users: 0, accounts: 0 },
    });
  });
});

describe("the sign-in routes core serves", () => {
  it("give a guest their own session alone, and a member nothing through a code", async () => {
    const mail = await mailbox();
    const guest = await signedInGuest();
    const member = await signedInApi(idp, "user");
    const memberEmail = String(member.person.email).toLowerCase();
    await askCode(memberEmail);
    const guestSession = sessionSchema.parse(await sessionOf(guest.cookie));
    // None of the code plugin's other routes is served.
    const others = await Promise.all(
      [
        "/email-otp/verify-email",
        "/email-otp/check-verification-otp",
        "/email-otp/request-password-reset",
        "/email-otp/reset-password",
        "/forget-password/email-otp",
        "/email-otp/request-email-change",
        "/email-otp/change-email",
      ].map(async (path) => {
        const response = await routed(`/api/auth${path}`, {
          method: "POST",
          headers: {
            origin: clientOrigin,
            "content-type": "application/json",
            cookie: guest.cookie,
          },
          body: JSON.stringify({ email: guest.address, otp: "00000000" }),
        });
        return response.status;
      })
    );
    const teams = await routed("/api/auth/organization/list-teams", {
      headers: { origin: clientOrigin, cookie: guest.cookie },
    });

    expect({
      guestSession: {
        guest: guestSession.session.guest,
        organization: guestSession.session.activeOrganizationId ?? null,
        email: guestSession.user.email,
      },
      teams: teams.status,
      others,
      memberMailed: mailsTo(mail, memberEmail).length,
      memberSignIn: await codeSignIn(memberEmail, "00000000"),
      memberSession: sessionSchema.parse(await sessionOf(member.session))
        .session.guest,
    }).toStrictEqual({
      guestSession: {
        guest: true,
        organization: null,
        email: guest.address,
      },
      teams: 403,
      others: others.map(() => 404),
      memberMailed: 0,
      memberSignIn: refused,
      memberSession: false,
    });
  });
});
