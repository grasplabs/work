import { addDays } from "@grasp-os/shared/admin/org-record";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  linkMail,
  reminderMail,
  updateMail,
} from "../src/onboarding/mail-text.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { adminCommands, adminSnapshot } from "./admin-command.ts";
import { mockIdp } from "./idp.ts";
import { onLink, participate } from "./interview-link.ts";
import { captureMail } from "./mail-capture.ts";
import { onboardingLog } from "./onboarding-log.ts";
import { openLink } from "./onboarding-team.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { auditedDuring, outcome, signedInApi } from "./sign-in.ts";

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
// - A failed mail lost: staff send it again, to the address the admin
//   corrected, and the audit log has that they did, not for whom.
// - The company's admin told whether someone finished by a failed mail:
//   its kind, its date, or a notice that appears once the reminder fails.

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

/** Whom a mail went to, and whether it was a reminder or the link. */
const whichTo = ({ to, subject }: EmailMessageBuilder) => [
  to,
  subject === reminderSubject ? "reminder" : "link",
];

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

  it("say whose failed, to staff and the company's admin, and are sent again by staff, audited without whom", async () => {
    const { api } = await signedInApi(idp, "admin");
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
    await adminCommands().setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
    await store.deliverMail();
    const failed = mail.tried.length - mail.sent.length;
    /** What staff and the company's admin are told of oli's and ona's mail. */
    const told = async () => {
      const snapshot = await adminSnapshot();
      const links = await api.onboarding.links();
      const failedMail =
        snapshot.links.find((link) => link.person === "oli")?.failedMail ??
        null;
      return {
        staff:
          failedMail === null
            ? null
            : { kind: failedMail.kind, reason: failedMail.reason },
        admin: links.map((link) => [link.person, link.mailFailed]),
      };
    };
    const toldFailed = await told();
    const audited = await auditedDuring(async () => {
      await adminCommands().sendMailAgain("oli");
      await store.deliverMail();
    });
    const nothingFailed = await outcome(adminCommands().sendMailAgain("ona"));
    const toldSent = await told();
    const entries = await onboardingLog("mail");
    const resent = audited.filter(
      ({ action }) => action === "onboarding.mail.resent"
    );
    expect({ toldFailed, toldSent }).toStrictEqual({
      toldFailed: {
        staff: { kind: "link", reason: "E_RECIPIENT_SUPPRESSED" },
        admin: [
          ["oli", true],
          ["ona", false],
        ],
      },
      toldSent: {
        staff: null,
        admin: [
          ["oli", false],
          ["ona", false],
        ],
      },
    });
    expect({
      failed,
      nothingFailed,
      sent: mail.sent.map(({ to }) => to),
      log: entries.map(({ what, about }) => [what, about ?? undefined]),
      resent: resent.map(({ actor, detail }) => [actor.type, detail]),
      audited: JSON.stringify(resent).includes("oli"),
    }).toStrictEqual({
      failed: 1,
      nothingFailed: "onboarding.no_failed_mail",
      sent: ["ona@acme.test", "oli@acme.test"],
      log: [
        ["mail.link.failed.recipient_suppressed", "oli"],
        ["mail.link.sent", "ona"],
        ["mail.link.again", "oli"],
        ["mail.link.sent", "oli"],
      ],
      resent: [["staff", {}]],
      audited: false,
    });
  });

  it("never tell the company's admin whether someone finished, and are sent again to the address the admin corrected", async () => {
    const { api } = await signedInApi(idp, "admin");
    const store = onboardingStore(env);
    const start = startMonday();
    // Uli finishes; Uma doesn't, and her reminder fails; Ute's link fails.
    // Confirmed: new people on a list saved while a plan is set wait.
    await api.onboarding.confirmRoster({
      teams: [{ id: "fin", name: "Finance", lead: null }],
      people: [
        { id: "uli", name: "Uli", email: "uli@acme.test", team: "fin" },
        { id: "uma", name: "Uma", email: "uma@acme.test", team: "fin" },
        { id: "ute", name: "Ute", email: "ute@acme.test", team: "fin" },
      ],
    });
    await api.onboarding.savePlan({ start, days: 14 });
    await adminCommands().setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
    // Ute's reminder fails too: it goes to the same address.
    const mail = await captureMail(
      store,
      "sent",
      "sent",
      "E_RECIPIENT_SUPPRESSED",
      "E_RECIPIENT_SUPPRESSED",
      "E_RECIPIENT_SUPPRESSED"
    );
    /** What the company's admin is told of each, every field but who. */
    const who = new Set(["person", "name", "email", "path"]);
    const told = async () => {
      const links = await api.onboarding.links();
      return Object.fromEntries(
        links.map((link) => [
          link.person,
          {
            ...Object.fromEntries(
              Object.entries(link).filter(([key]) => !who.has(key))
            ),
            out: link.path !== null,
          },
        ])
      );
    };
    await store.releaseDue(morning(start));
    await store.deliverMail(Date.parse(morning(start)));
    const afterLinks = await told();
    await store.noteInterview({
      person: "uli",
      kind: "own",
      startedAt: morning(start, 1),
      completedAt: morning(start, 1),
    });
    const reminded = await store.remindDue(morning(start, 3));
    await store.deliverMail(Date.parse(morning(start, 3)));
    const afterReminder = await told();
    const snapshot = await adminSnapshot();
    const staffSaw = snapshot.links
      .filter(({ failedMail }) => failedMail !== null)
      .map(({ person: id, failedMail }) => [id, failedMail?.kind]);
    /** The roster with Ute at `email`, as the admin saves it. */
    const uteAt = async (email: string) =>
      await api.onboarding.saveRoster({
        teams: [{ id: "fin", name: "Finance", lead: null }],
        people: [
          { id: "uli", name: "Uli", email: "uli@acme.test", team: "fin" },
          { id: "uma", name: "Uma", email: "uma@acme.test", team: "fin" },
          { id: "ute", name: "Ute", email, team: "fin" },
        ],
      });
    // With no address, staff are told so, and nothing goes.
    await uteAt("");
    const noAddress = await outcome(adminCommands().sendMailAgain("ute"));
    // The admin corrects Ute's address; Grasp sends her link again.
    await uteAt("ute@acme-mail.test");
    const sentBefore = mail.sent.length;
    const audited = await auditedDuring(async () => {
      await adminCommands().sendMailAgain("ute");
      await store.deliverMail(Date.parse(morning(start, 3)));
    });
    const resent = audited.filter(
      ({ action }) => action === "onboarding.mail.resent"
    );
    const afterAgain = await told();
    const unfinished = { team: "Finance", fresh: true, out: true };
    expect({
      noAddress,
      // One event for both mails: no person, no kind, no count.
      resent: resent.map(({ actor, target, detail }) => [
        actor.type,
        target ?? null,
        detail,
      ]),
      names: JSON.stringify(resent).includes("ute"),
      reminded,
      tried: mail.tried.map(whichTo),
      again: mail.sent.slice(sentBefore).map(whichTo),
      afterLinks,
      afterReminder,
      staffSaw,
      afterAgain: afterAgain.ute,
    }).toStrictEqual({
      noAddress: "onboarding.no_address",
      resent: [["staff", { type: "onboarding", id: "onboarding" }, {}]],
      names: false,
      reminded: ["uma", "ute"],
      tried: [
        ["uli@acme.test", "link"],
        ["uma@acme.test", "link"],
        ["ute@acme.test", "link"],
        ["uma@acme.test", "reminder"],
        ["ute@acme.test", "reminder"],
        ["ute@acme-mail.test", "link"],
        ["ute@acme-mail.test", "reminder"],
      ],
      // Both of hers, to the address the admin corrected.
      again: [
        ["ute@acme-mail.test", "link"],
        ["ute@acme-mail.test", "reminder"],
      ],
      afterLinks: {
        uli: { ...unfinished, mailFailed: false },
        uma: { ...unfinished, mailFailed: false },
        ute: { ...unfinished, mailFailed: true },
      },
      // Uma's reminder failed, Uli finished: to the admin, the same.
      afterReminder: {
        uli: { ...unfinished, mailFailed: false },
        uma: { ...unfinished, mailFailed: false },
        ute: { ...unfinished, mailFailed: true },
      },
      staffSaw: [
        ["uma", "reminder"],
        ["ute", "reminder"],
      ],
      afterAgain: { ...unfinished, mailFailed: false },
    });
  });

  it("send a failed reminder again only to whoever is still owed one, when it is sent and when it goes", async () => {
    const { api } = await signedInApi(idp, "admin");
    const store = onboardingStore(env);
    // Running since yesterday, so their links open now.
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = addDays(today, -1);
    // Every reminder fails. Then Pam finishes, Pat withdraws, Pia deletes
    // her interview; Pol's link had failed too and he is still owed it;
    // Peg is sent hers again and finishes before it goes. In the order
    // their mails go: by the roster for links, by id for reminders. Pip
    // withdraws before reminder day: never reminded at all.
    const [pam, pat, pia, pol, peg, pip] = ["pa", "pb", "pc", "pd", "pe", "pf"];
    const owed = [pam, pat, pia, pol, peg];
    const people = [...owed, pip];
    // Before anything goes: their links go out as the agreements are in.
    const mail = await captureMail(
      store,
      "sent",
      "sent",
      "sent",
      "E_RECIPIENT_SUPPRESSED",
      "sent",
      "sent",
      ...owed.map(() => "E_RECIPIENT_SUPPRESSED"),
      // Peg's, sent again: the service is busy, so it waits.
      "E_RATE_LIMIT_EXCEEDED"
    );
    await api.onboarding.confirmRoster({
      teams: [{ id: "rnd", name: "Research", lead: null }],
      people: people.map((id) => ({
        id,
        name: id,
        email: `${id}@acme.test`,
        team: "rnd",
      })),
    });
    await store.savePlan({ start: yesterday, days: 14 }, { type: "system" });
    await adminCommands().setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
    await store.releaseDue();
    await store.deliverMail();
    const patLink = await openLink(pat);
    await participate(patLink);
    const piaLink = await openLink(pia);
    const pipLink = await openLink(pip);
    await participate(pipLink);
    await onLink({ action: "withdraw", ...pipLink });
    const remindOn = `${addDays(today, 5)}T08:00:00.000Z`;
    const reminded = await store.remindDue(remindOn);
    await store.deliverMail(Date.parse(remindOn));
    const triedBefore = mail.tried.length;
    const snapshot = await adminSnapshot();
    const pipReminded = snapshot.links.find(
      (link) => link.person === pip
    )?.remindedAt;

    const now = new Date().toISOString();
    await store.noteInterview({
      person: pam,
      kind: "own",
      startedAt: now,
      completedAt: now,
    });
    await onLink({ action: "withdraw", ...patLink });
    await onLink({ action: "delete", ...piaLink });
    const notOwed = [
      await outcome(adminCommands().sendMailAgain(pam)),
      await outcome(adminCommands().sendMailAgain(pat)),
      await outcome(adminCommands().sendMailAgain(pia)),
    ];
    // Peg's goes back in the outbox, is tried once, and waits.
    const pegAgain = await outcome(adminCommands().sendMailAgain(peg));
    await store.deliverMail();
    await store.noteInterview({
      person: peg,
      kind: "own",
      startedAt: now,
      completedAt: now,
    });
    await store.deliverMail(Date.now() + 2 * dayMs);
    const polAgain = await outcome(adminCommands().sendMailAgain(pol));
    await store.deliverMail(Date.now() + 2 * dayMs);

    expect({
      reminded,
      pipReminded,
      notOwed,
      pegAgain,
      polAgain,
      after: mail.tried.slice(triedBefore).map(whichTo),
    }).toStrictEqual({
      reminded: owed,
      pipReminded: null,
      notOwed: [
        "onboarding.reminder_not_owed",
        "onboarding.reminder_not_owed",
        "onboarding.reminder_not_owed",
      ],
      pegAgain: "ok",
      polAgain: "ok",
      after: [
        // Tried once while she was owed it; never again once she finished.
        [`${peg}@acme.test`, "reminder"],
        [`${pol}@acme.test`, "link"],
        [`${pol}@acme.test`, "reminder"],
      ],
    });
  });

  it("show staff a failed link the admin is told of, though a reminder reached them since, so staff can send it again", async () => {
    const { api } = await signedInApi(idp, "admin");
    const store = onboardingStore(env);
    const start = startMonday();
    // Vic's link fails; the admin puts his address right before reminder
    // day, so the reminder reaches him.
    const mail = await captureMail(store, "E_RECIPIENT_SUPPRESSED");
    const vicAt = async (email: string) =>
      await api.onboarding.confirmRoster({
        teams: [{ id: "law", name: "Legal", lead: null }],
        people: [{ id: "vic", name: "Vic", email, team: "law" }],
      });
    await vicAt("vic@acme.test");
    await api.onboarding.savePlan({ start, days: 14 });
    await adminCommands().setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
    await store.releaseDue(morning(start));
    await store.deliverMail(Date.parse(morning(start)));
    await vicAt("vic@acme-mail.test");
    await store.remindDue(morning(start, 3));
    await store.deliverMail(Date.parse(morning(start, 3)));
    /** What the admin and staff are told of Vic's mail. */
    const told = async () => {
      const links = await api.onboarding.links();
      const snapshot = await adminSnapshot();
      return {
        admin: links.find((link) => link.person === "vic")?.mailFailed,
        staff:
          snapshot.links.find((link) => link.person === "vic")?.failedMail
            ?.kind ?? null,
      };
    };
    const before = await told();
    await adminCommands().sendMailAgain("vic");
    await store.deliverMail(Date.parse(morning(start, 3)));
    const after = await told();
    expect({
      tried: mail.tried.map(whichTo),
      before,
      after,
    }).toStrictEqual({
      tried: [
        ["vic@acme.test", "link"],
        ["vic@acme-mail.test", "reminder"],
        ["vic@acme-mail.test", "link"],
      ],
      before: { admin: true, staff: "link" },
      after: { admin: false, staff: null },
    });
  });

  it("remind a company of hundreds with work that grows with its size, not with its size squared", async () => {
    const { api } = await signedInApi(idp, "admin");
    const store = onboardingStore(env);
    await captureMail(store);
    const size = 300;
    const ids = Array.from({ length: size }, (_, index) => `big${index}`);
    await api.onboarding.confirmRoster({
      teams: [{ id: "big", name: "Operations", lead: null }],
      people: ids.map((id) => ({
        id,
        name: id,
        email: `${id}@acme.test`,
        team: "big",
      })),
    });
    const today = new Date().toISOString().slice(0, 10);
    await store.savePlan(
      { start: addDays(today, -1), days: 14 },
      { type: "system" }
    );
    await adminCommands().setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
    await store.releaseDue();
    await store.deliverMail();
    // The rows the store's own database reads while it reminds them all.
    const cursors: { rowsRead: number }[] = [];
    await runInDurableObject(store, (_instance, state) => {
      const { sql } = state.storage;
      const exec = sql.exec.bind(sql);
      Reflect.set(sql, "exec", (...args: Parameters<typeof exec>) => {
        const cursor = exec(...args);
        cursors.push(cursor);
        return cursor;
      });
    });
    const reminded = await store.remindDue(
      `${addDays(today, 5)}T08:00:00.000Z`
    );
    await runInDurableObject(store, (_instance, state) => {
      Reflect.deleteProperty(state.storage.sql, "exec");
    });
    const rowsRead = cursors.reduce((sum, { rowsRead: n }) => sum + n, 0);
    expect({
      reminded: reminded.length,
      // About 40 a person now; 640 a person when each one read the whole
      // roster and every interview again (2,000 people: millions of rows).
      withinBound: rowsRead < size * 100,
    }).toStrictEqual({ reminded: size, withinBound: true });
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
