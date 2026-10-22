import { addDays } from "@grasp-os/shared/admin/org-record";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  linkMail,
  reminderMail,
  updateMail,
} from "../src/onboarding/mail-text.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { captureMail } from "./mail-capture.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Grasp emails everyone their interview link on its day, and one reminder
// to whoever hasn't finished three working days later; the company's
// onboarding admin gets an update twice a week (src/onboarding/store.ts,
// mail-text.ts), all through the mail outbox, with Email Sending stood in
// for (test/mail-capture.ts). What must not happen, tried here:
//
// - A link by email before its day, or a team's before its lead's turn.
// - A second reminder, or one to someone who finished.
// - A mail in another language than the interviews', or from the company's
//   own domain rather than Grasp's.
// - The admin's update naming anyone.
// - A failed mail lost: staff send it again, and the audit log has that
//   they did, not for whom.

const idp = mockIdp();

/** A name nobody else uses, to look for where it must not be. */
const sentinel = "Zebulon Quillfeather";

const dayMs = 24 * 60 * 60 * 1000;

/** A Monday at least a week ahead: the interviews' first day. */
const startMonday = (): string => {
  let at = Date.now() + 7 * dayMs;
  while (new Date(at).getUTCDay() !== 1) {
    at += dayMs;
  }
  return new Date(at).toISOString().slice(0, 10);
};

/** Eight in the morning (UTC) on `day`, `days` days on. */
const morning = (day: string, days = 0): string =>
  `${addDays(day, days)}T08:00:00.000Z`;

const person = (id: string, name: string, email = `${id}@acme.test`) => ({
  id,
  name,
  email,
  team: "sales",
});

/** Sales, led by Lea; Sam and Sid in it, and Pia, who has no address. */
const roster: RosterInput = {
  teams: [{ id: "sales", name: "Sales", lead: "lea" }],
  people: [
    person("lea", `Lea ${sentinel}`),
    person("sam", "Sam Berg"),
    person("sid", "Sid Holm"),
    person("pia", "Pia Lund", ""),
  ],
};

/** A store of its own, its interviews planned from `start` and open. */
const plannedStore = async (start: string) => {
  const store = env.ONBOARDING.getByName(`emails-${crypto.randomUUID()}`);
  const by = { type: "system" } as const;
  await store.saveRoster(
    {
      teams: roster.teams.map((team) => ({ does: "", off: false, ...team })),
      people: roster.people.map((one) => ({
        email: "",
        title: "",
        away: false,
        ...one,
      })),
    },
    by
  );
  await store.savePlan({ start, days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  return store;
};

/** Who each mail went to, and what it was about, from its subject. */
const sentTo = (mail: { sent: EmailMessageBuilder[] }) =>
  mail.sent.map(({ to, subject }) => ({ to, subject }));

const linkSubject = "acme.test would like to hear how your work goes";
const reminderSubject = "A reminder: your interview with Stephen";

describe("the interview link emails", () => {
  it("send a lead's link on the start day, the team's once the lead's turn is over, one reminder on the third working day, and no second", async () => {
    const start = startMonday();
    const store = await plannedStore(start);
    const mail = await captureMail(store);
    /** Releases and reminds as the alarm does on `day`, and sends the mail. */
    const on = async (day: string) => {
      const released = await store.releaseDue(day);
      const reminded = await store.remindDue(day);
      await store.deliverMail(Date.parse(day));
      return { released, reminded };
    };
    const days = {
      sunday: await on(morning(start, -1)),
      monday: await on(morning(start)),
      tuesday: await on(morning(start, 1)),
    };
    const afterLead = mail.sent.length;
    // Lea talks on Tuesday; nobody has drawn her team's map, so Sales
    // waits out the lead's three working days.
    await store.noteInterview({
      person: "lea",
      kind: "lead",
      startedAt: morning(start, 1),
      completedAt: morning(start, 1),
    });
    const later = {
      thursday: await on(morning(start, 3)),
      nextMonday: await on(morning(start, 7)),
    };
    // Sid finishes; Sam doesn't.
    await store.noteInterview({
      person: "sid",
      kind: "own",
      startedAt: morning(start, 7),
      completedAt: morning(start, 7),
    });
    const last = {
      nextTuesday: await on(morning(start, 8)),
      nextWednesday: await on(morning(start, 9)),
      nextThursday: await on(morning(start, 10)),
    };
    expect({ ...days, afterLead, ...later, ...last }).toStrictEqual({
      sunday: { released: [], reminded: [] },
      monday: { released: ["lea"], reminded: [] },
      tuesday: { released: [], reminded: [] },
      afterLead: 1,
      // Pia's link is out too, handed to her: she has no address.
      thursday: { released: ["sam", "sid", "pia"], reminded: [] },
      nextMonday: { released: [], reminded: [] },
      nextTuesday: { released: [], reminded: ["sam"] },
      nextWednesday: { released: [], reminded: [] },
      nextThursday: { released: [], reminded: [] },
    });
    expect(sentTo(mail)).toStrictEqual([
      { to: "lea@acme.test", subject: linkSubject },
      { to: "sam@acme.test", subject: linkSubject },
      { to: "sid@acme.test", subject: linkSubject },
      { to: "sam@acme.test", subject: reminderSubject },
    ]);
  });

  it("are from Grasp, in the language Stephen interviews in, naming the company, with the link in the mail alone", async () => {
    const { api } = await signedInApi(idp, "admin");
    await api.organization.update({ name: "Acme Werke" });
    const start = startMonday();
    const store = await plannedStore(start);
    await store.saveStephen(
      { languages: ["de"], limits: [], terms: [] },
      { type: "system" }
    );
    const mail = await captureMail(store);
    await store.releaseDue(morning(start));
    await store.deliverMail(Date.parse(morning(start)));
    const [sent] = mail.sent;
    const link = new RegExp(
      `${clientOrigin}/interview#[A-Za-z0-9_-]{43}`,
      "u"
    ).exec(sent?.text ?? "")?.[0];
    expect({
      from: sent?.from,
      replyTo: sent?.replyTo,
      subject: sent?.subject,
      hello: sent?.text?.startsWith("Hallo Lea,"),
      lead: sent?.text?.includes("über die Arbeit Ihres Teams"),
      link: link !== undefined && (sent?.html?.includes(link) ?? false),
      surname: sent?.text?.includes(sentinel),
      headers: sent?.headers,
    }).toStrictEqual({
      from: { name: "Stephen at Grasp", email: "onboarding@mail.grasp.test" },
      replyTo: "ada@acme.test",
      subject: "Acme Werke möchte wissen, wie Ihre Arbeit läuft",
      hello: true,
      lead: true,
      link: true,
      surname: false,
      headers: {
        "List-Unsubscribe": "<mailto:ada@acme.test?subject=Unsubscribe>",
        "Content-Language": "de",
      },
    });
  });

  it("give the admin an update on Mondays and Thursdays, once a day, with numbers and no name", async () => {
    const start = startMonday();
    const store = await plannedStore(start);
    const mail = await captureMail(store);
    await store.releaseDue(morning(start));
    await store.noteInterview({
      person: "lea",
      kind: "lead",
      startedAt: morning(start, 1),
      completedAt: morning(start, 1),
    });
    const sends = [];
    // From the start day to the next Monday's, twice on Thursday.
    for (const days of [0, 1, 2, 3, 3, 4, 7]) {
      // oxlint-disable-next-line no-await-in-loop -- one day after another
      sends.push(await store.sendUpdate(morning(start, days)));
    }
    await store.deliverMail(Date.parse(morning(start, 7)));
    const updates = mail.sent.filter(({ to }) => to === "ada@acme.test");
    expect({
      sends,
      updates: updates.length,
      leads: updates[0]?.text?.includes("Team leads who talked: 1 of 1."),
      names: updates.some(({ text, html }) =>
        roster.people.some(({ name }) =>
          [text, html].some((body) => body?.includes(name) === true)
        )
      ),
    }).toStrictEqual({
      sends: [false, false, false, true, false, false, true],
      updates: 2,
      leads: true,
      names: false,
    });
  });

  it("are sent again by staff when one failed, audited without whom", async () => {
    const { api } = await signedInApi(idp, "admin");
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session);
    const staff = await core.authenticate();
    const store = onboardingStore(env);
    const mail = await captureMail(store, "E_RECIPIENT_SUPPRESSED");
    await api.onboarding.saveRoster({
      teams: [{ id: "ops", name: "Ops", lead: null }],
      people: [
        { id: "oli", name: sentinel, email: "oli@acme.test", team: "ops" },
        { id: "ona", name: "Ona", email: "ona@acme.test", team: "ops" },
      ],
    });
    await api.onboarding.savePlan({
      start: new Date().toISOString().slice(0, 10),
      days: 14,
    });
    await staff.onboardingStaff.setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
    await store.deliverMail();
    const failed = mail.tried.length - mail.sent.length;
    const byAdmin = await outcome(api.onboardingStaff.sendMailAgain("oli"));
    const audited = await auditedDuring(async () => {
      await staff.onboardingStaff.sendMailAgain("oli");
      await store.deliverMail();
    });
    const nothingFailed = await outcome(
      staff.onboardingStaff.sendMailAgain("ona")
    );
    const { entries } = await staff.onboardingStaff.log({ what: "mail" });
    const resent = audited.filter(
      ({ action }) => action === "onboarding.mail.resent"
    );
    expect({
      failed,
      byAdmin,
      nothingFailed,
      sent: mail.sent.map(({ to }) => to),
      log: entries.map(({ what, person: one }) => [what, one?.id]).toReversed(),
      resent: resent.map(({ actor, detail }) => [actor.type, detail]),
      audited: JSON.stringify(resent).includes("oli"),
    }).toStrictEqual({
      failed: 1,
      byAdmin: "onboarding.staff_only",
      nothingFailed: "onboarding.no_failed_mail",
      sent: ["ona@acme.test", "oli@acme.test"],
      log: [
        ["mail.link.failed.recipient_suppressed", "oli"],
        ["mail.link.sent", "ona"],
        ["mail.link.again", "oli"],
        ["mail.link.sent", "oli"],
      ],
      resent: [["staff", { kind: "link" }]],
      audited: false,
    });
  });
});

describe("the onboarding's mail texts", () => {
  it("fill in every place in every language, and leave only the link to the outbox", () => {
    const words = {
      name: "Ana",
      company: "Acme",
      closes: "2026-10-30",
      replyTo: "ada@acme.test",
    };
    const place = /\{[^}]*\}/u;
    const mails = interviewLocales.flatMap((locale) => [
      { locale, mail: linkMail({ ...words, locale, kind: "own" }), link: true },
      {
        locale,
        mail: linkMail({ ...words, locale, kind: "lead" }),
        link: true,
      },
      { locale, mail: reminderMail({ ...words, locale }), link: true },
      {
        locale,
        mail: updateMail({
          locale,
          company: "Acme",
          closes: "2026-10-30",
          numbers: { asked: 17, talked: 11, leadsTalked: 2, leads: 3 },
        }),
        link: false,
      },
    ]);
    const wrong = mails.filter(({ mail, link }) => {
      const all = `${mail.subject}\n${mail.text}\n${mail.html}`;
      return (
        place.test(all.replaceAll("{{link}}", "")) ||
        mail.text.includes("{{link}}") !== link ||
        !mail.text.includes("30") ||
        (link && !mail.text.includes("Ana")) ||
        (!link &&
          !["17", "11", "2", "3"].every((count) => mail.text.includes(count)))
      );
    });
    expect(wrong.map(({ locale }) => locale)).toStrictEqual([]);
  });
});
