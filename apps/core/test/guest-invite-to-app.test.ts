import type { SubjectMember } from "@grasp-os/shared/subject-members";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { captureMail } from "./mail-capture.ts";
import type { CapturedMail } from "./mail-capture.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Inviting an address that belongs to nobody yet from an App's sharing
// screen (GRA-2235): one call invites it as a guest and shares the App
// with them as its user (app-members.ts `inviteGuestToApp`). From the
// threat model on the issue: only whoever may share the App invites
// through it; an App that holds a source invites nobody; a refused
// address shares nothing; a repeat invites, shares and mails once; and
// the guest is mailed, once per new share, the App's name and where to
// sign in.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** An address outside the company, no other test's. */
const outsider = (): string => `guest-${unique()}@partner.test`;

/** Captures what core mails from now on. */
const mailbox = async (): Promise<CapturedMail> =>
  await captureMail(onboardingStore(env));

/** The mails sent so far to `address`. */
const mailsTo = (mail: CapturedMail, address: string): EmailMessageBuilder[] =>
  mail.sent.filter((message) => {
    const [to] = [message.to].flat();
    return (typeof to === "string" ? to : to?.email) === address;
  });

/** A builder's new App, which holds no source. */
const ledger = async () => {
  const builder = await signedInApi(idp, "builder");
  const name = `Ledger ${unique()}`;
  const { id } = await builder.api.apps.create({ name });
  return { builder, app: id, name };
};

/** Marks `app` as having read the Brain by default: a source. */
const readsTheBrain = async (app: string): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO brain_default_reads (subject_type, subject_id, first_read_at) VALUES ('app', ?, ?)"
  )
    .bind(app, Date.now())
    .run();
};

/** How many users hold `address`: whether anyone was invited. */
const usersAt = async (address: string): Promise<number> =>
  (await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email = ?")
    .bind(address)
    .first<number>("n")) ?? 0;

/** The people `app` is shared with, by ID. */
const sharedWith = async (by: Person, app: string): Promise<string[]> => {
  const members = await by.api.apps.members.list(app);
  return members.map(({ id }) => id);
};

describe("inviting a guest from an App's sharing screen", () => {
  it("invites an address of nobody's and shares the App with them as its user, audited by ID and mailed once", async () => {
    const mail = await mailbox();
    const { builder, app, name } = await ledger();
    const address = outsider();

    let made: SubjectMember | undefined;
    const events = await auditedDuring(async () => {
      made = await builder.api.apps.members.inviteGuest(
        app,
        ` ${address.toUpperCase()} `
      );
    });
    const [sent] = mailsTo(mail, address);

    expect({
      member: made,
      events: events.map(({ action, target }) => ({ action, target })),
      address: JSON.stringify(events).includes(address),
      mails: mailsTo(mail, address).length,
      subject: sent?.subject,
      signIn: sent?.text?.includes(`sign in at ${clientOrigin}/sign-in`),
    }).toMatchObject({
      member: { type: "person", name: address, role: "user", guest: true },
      events: [
        { action: "member.guest_invited", target: { type: "user" } },
        { action: "app.member.added", target: { type: "app", id: app } },
      ],
      address: false,
      mails: 1,
      subject: `${name} was shared with you in Grasp`,
      signIn: true,
    });
    expect(events[0]?.target).toStrictEqual({ type: "user", id: made?.id });
  });

  it("invites, shares and mails once when asked again, or twice at once", async () => {
    const mail = await mailbox();
    const { builder, app } = await ledger();
    const address = outsider();
    const atOnce = outsider();

    const first = await builder.api.apps.members.inviteGuest(app, address);
    const again = await auditedDuring(async () => {
      await expect(
        builder.api.apps.members.inviteGuest(app, address)
      ).resolves.toMatchObject({ id: first.id });
    });
    const both = await Promise.all([
      builder.api.apps.members.inviteGuest(app, atOnce),
      builder.api.apps.members.inviteGuest(app, atOnce),
    ]);
    const shared = await sharedWith(builder, app);

    expect({
      againEvents: again.length,
      sameGuest: both[0].id === both[1].id,
      users: [await usersAt(address), await usersAt(atOnce)],
      rows: shared.filter((id) => id === first.id || id === both[0].id).length,
      mails: [mailsTo(mail, address).length, mailsTo(mail, atOnce).length],
    }).toStrictEqual({
      againEvents: 0,
      sameGuest: true,
      users: [1, 1],
      rows: 2,
      mails: [1, 1],
    });
  });

  it("invites nobody to an App that holds a source, and records the refusal without the address", async () => {
    const mail = await mailbox();
    const { builder, app } = await ledger();
    await readsTheBrain(app);
    const address = outsider();

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(
        builder.api.apps.members.inviteGuest(app, address)
      );
    });

    expect({
      refused,
      users: await usersAt(address),
      mails: mailsTo(mail, address).length,
      events: events.map(({ action, detail }) => ({ action, detail })),
    }).toStrictEqual({
      refused: "app.guest_sources",
      users: 0,
      mails: 0,
      events: [
        {
          action: "app.member.refused",
          detail: {
            memberType: "person",
            role: "user",
            reason: "app.guest_sources",
          },
        },
      ],
    });
  });

  it("shares nothing when the address is refused: the company's, a member's, Grasp's, someone removed, or no address", async () => {
    const mail = await mailbox();
    const { builder, app } = await ledger();
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const removed = outsider();
    const { userId } = await admin.api.members.inviteGuest(removed);
    await admin.api.members.remove(userId);
    const before = await sharedWith(builder, app);
    const invite = async (address: string) =>
      await outcome(builder.api.apps.members.inviteGuest(app, address));

    expect({
      member: await invite(String(member.person.email)),
      company: await invite(`new-${unique()}@acme.test`),
      staff: await invite(`staff-${unique()}@grasp.test`),
      removed: await invite(removed),
      notAnAddress: await invite("someone"),
      shared: await sharedWith(builder, app),
      mails: mail.sent.length,
    }).toStrictEqual({
      member: "member.guest_refused",
      company: "member.guest_refused",
      staff: "member.guest_refused",
      removed: "member.invite_removed",
      notAnAddress: "member.guest_email",
      shared: before,
      mails: 0,
    });
  });

  it("invites nobody for someone who may not share the App, nor for Grasp staff", async () => {
    const { app } = await ledger();
    const otherBuilder = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staffSession);
    const staff = core.authenticate();
    // A source, so staff's refusal can't be the source rule's.
    const sourced = await ledger();
    await readsTheBrain(sourced.app);
    const addresses = [outsider(), outsider(), outsider()];

    let byStaff = "";
    const staffEvents = await auditedDuring(async () => {
      byStaff = await outcome(
        staff.apps.members.inviteGuest(sourced.app, addresses[2] ?? "")
      );
    });

    expect({
      otherBuilder: await outcome(
        otherBuilder.api.apps.members.inviteGuest(app, addresses[0] ?? "")
      ),
      user: await outcome(
        user.api.apps.members.inviteGuest(app, addresses[1] ?? "")
      ),
      byStaff,
      staffEvents: staffEvents.length,
      users: await Promise.all(addresses.map(usersAt)),
    }).toStrictEqual({
      otherBuilder: "app.not_found",
      user: "app.not_found",
      byStaff: "role.forbidden",
      staffEvents: 0,
      users: [0, 0, 0],
    });
  });

  it("mails a guest who has an account each time an App is newly shared with them, and not again for the same App", async () => {
    const mail = await mailbox();
    const { builder, app, name } = await ledger();
    const other = await ledger();
    const admin = await signedInApi(idp, "admin");
    const address = outsider();
    const { userId } = await admin.api.members.inviteGuest(address);
    const asUser = { type: "person", id: userId, role: "user" } as const;

    await builder.api.apps.members.add(app, asUser);
    await builder.api.apps.members.add(app, asUser);
    await other.builder.api.apps.members.add(other.app, asUser);

    expect(mailsTo(mail, address).map(({ subject }) => subject)).toStrictEqual(
      [name, other.name].map((each) => `${each} was shared with you in Grasp`)
    );
  });
});
