/**
 * `vp run seed:onboarding`: fills a fresh local stack (`vp run dev`) with
 * Noordkade Finance (scripts/seed/company.ts) halfway through its
 * onboarding, as a demo of what the company's admin and Grasp's staff see
 * while Stephen talks to the team: day 8 of 14, the kickoff read, the
 * staff list confirmed with a lead for every team, where the documents
 * live, Pulse and the HR platform chosen, the agreements in, every link
 * out, five of six leads heard, Customer service still quiet, and the
 * gate closed, with Grasp knowing about 75% of the company: short of the
 * 80% at which staff give their go.
 *
 * Everything an API does goes through core's API as the person who would
 * do it: the admin, and Grasp's staff member (staff@grasp.test). Written
 * straight into the local state is only what no API can do on a stack
 * without a model or days gone by: the admin's full name, as the seed
 * gives it; the kickoff's reading, which Stephen makes from a transcript
 * through the model gateway; the plan, moved back a week; when each link
 * went out; and who talked, as team tallies and each person's interview
 * finished, never what they said.
 *
 * A plan is never moved once saved, so this only seeds an onboarding with
 * none yet: not after `vp run seed`, whose company is in its fifth week.
 * To start over, stop `vp run dev`, delete `apps/core/.wrangler/state`,
 * and start it again. Like the seed, it only ever reaches localhost
 * (scripts/seed/local.ts).
 */
import type { DatabaseSync } from "node:sqlite";

import { addWorkingDays } from "@grasp-os/shared/admin/org-record";
import { visionFields } from "@grasp-os/shared/kickoff";
import type { KickoffReading } from "@grasp-os/shared/kickoff";
import { onboardingErrors, planDays } from "@grasp-os/shared/onboarding";
import { organizationErrors } from "@grasp-os/shared/organization";

import { localStaff } from "../apps/core/test/sign-in-config.ts";
import { companyName, people, roster } from "./seed/company.ts";
import { localD1, localObject, sessionOf } from "./seed/local.ts";

const dayMs = 24 * 60 * 60 * 1000;

const [admin] = people;

/** Who spoke for the company in the kickoff: its CEO. */
const sponsor = "Daan Kuiper";

/** The day `days` from today (UTC), as `YYYY-MM-DD`. */
const daysFromToday = (days: number): string =>
  new Date(Date.now() + days * dayMs).toISOString().slice(0, 10);

/** Which day of the interviews it is today: the eighth of fourteen. */
const dayOfPlan = 8;

const start = daysFromToday(1 - dayOfPlan);

/**
 * How many of each team talked by yesterday, its lead aside, and whether
 * its lead did. Customer service is the quiet team: under three talked, so
 * the admin sees only that its fifteen were asked, and Stephen suggests a
 * word from Lisa, their lead.
 */
const heard: Record<string, { talked: number; lead: boolean }> = {
  "team-onboarding": { talked: 4, lead: true },
  "team-mortgage": { talked: 10, lead: true },
  "team-service": { talked: 2, lead: false },
  "team-finance": { talked: 5, lead: true },
  "team-compliance": { talked: 3, lead: true },
  "team-operations": { talked: 4, lead: true },
};

/**
 * The kickoff with Noordkade's sponsor as Stephen reads it: every one of
 * the ten things he needs said, each with the words it rests on.
 */
const reading: KickoffReading = {
  sponsor: "Daan",
  fields: {
    business: {
      text: "A mortgage and lending adviser in the Netherlands: advice, applications and aftercare for home buyers.",
      quote:
        "We advise people buying a home, we put the mortgage application together with the lender, and we look after them for years afterwards.",
    },
    teams: {
      text: "Six teams: client onboarding, mortgage advice, customer service, finance, compliance and operations.",
      quote:
        "It's onboarding, the advisers, the service desk, finance, compliance and ops. About sixty people in all.",
    },
    goals: {
      text: "Halve the time from first contact to a complete mortgage file.",
      quote:
        "If we could get from the first call to a complete file in half the time, that would change everything for us.",
    },
    success: {
      text: "Advisers spend their time advising, not chasing documents.",
      quote:
        "Success is when an adviser spends the day advising and not chasing payslips.",
    },
    stakeholders: {
      text: "Daan Kuiper, the CEO, sponsors it; Sanne de Wit, the COO, runs it with the team leads.",
      quote:
        "I'm the sponsor, Sanne runs it, but Nina, Mark and Lisa are the ones who have to live with it.",
    },
    pain: {
      text: "Collecting and checking clients' documents by hand, across email and the CRM.",
      quote:
        "Half the week goes into collecting documents from email and checking them against what's in the CRM.",
    },
    limits: {
      text: "No client data leaves the EU, and nothing is sent to a lender without an adviser's check.",
      quote:
        "Nothing leaves the EU, and nothing goes to a lender unless an adviser has looked at it.",
    },
    sensitivities: {
      text: "Clients' financial data, and people worried that AI judges their work.",
      quote:
        "People will ask whether this is about checking up on them. It isn't, and we need to say so.",
    },
    systems: {
      text: "Microsoft 365, the CRM, the lenders' portals and Exact for finance.",
      quote:
        "We live in Outlook and Teams, the CRM, the lenders' portals, and finance runs on Exact.",
    },
    languages: {
      text: "Dutch at work, English for some of the advisers.",
      quote:
        "Everyone speaks Dutch at work; a few of the advisers prefer English.",
    },
  },
  ask: {},
  teams: [
    { name: "Client onboarding", does: "Takes new clients in", people: 6 },
    { name: "Mortgage advice", does: "Advises and applies", people: 18 },
    { name: "Customer service", does: "Answers clients", people: 15 },
    { name: "Finance", does: "Invoices and commissions", people: 8 },
    { name: "Compliance", does: "Checks files and advice", people: 5 },
    { name: "Operations", does: "Keeps the office running", people: 9 },
  ],
};

/** A transcript long enough to be a conversation, made of what the reading quotes. */
const transcript = visionFields
  .map((field) => `${sponsor}: ${reading.fields[field]?.quote ?? ""}`)
  .join("\n\n");

/** Runs `write` on the Onboarding object's state, then lets go of it. */
const inStore = (write: (db: DatabaseSync) => void): void => {
  const db = localObject("Onboarding", "onboarding", "1");
  try {
    db.exec("BEGIN");
    write(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

/** Midday on `day`, as ISO 8601: when something happened that day. */
const atNoon = (day: string, hour = 12): string =>
  `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;

/**
 * The days of the plan before today, from its second: when people talked,
 * spread out, the way they do.
 */
const pastDays = Array.from({ length: dayOfPlan - 2 }, (_, index) =>
  daysFromToday(index + 2 - dayOfPlan)
);

const main = async (): Promise<void> => {
  const adminSession = await sessionOf(admin.email);
  const staff = await sessionOf(localStaff, { providerId: "grasp-staff" });
  try {
    const { onboarding, organization } = adminSession.api;
    const view = await onboarding.view();
    if (view.plan !== null) {
      throw new Error(
        "This stack's onboarding has a plan already, which never moves once saved. Stop `vp run dev`, delete apps/core/.wrangler/state, start it again and seed it with this alone."
      );
    }

    const { name } = await organization.get();
    if (name !== companyName) {
      await organization.update({ name: companyName });
    }
    // The fake IdP names people by their email's first word: Stephen
    // greets the admin by their own name.
    const core = localD1("workflow_runs");
    try {
      core
        .prepare("UPDATE users SET name = ? WHERE id = ?")
        .run(admin.name, adminSession.userId);
    } finally {
      core.close();
    }

    // What the admin did in their setup: the staff list, confirmed with
    // its leads; the documents in SharePoint and Teams, Pulse wanted, AFAS
    // for HR; the plan.
    const company = roster();
    await onboarding.confirmRoster(company);
    await onboarding.saveChoices({
      sources: ["sharepoint", "teams"],
      sourcesWanted: [],
      pulse: "wanted",
      hr: { kind: "platform", name: "AFAS" },
    });
    await onboarding.savePlan({ start: daysFromToday(0) });

    // The kickoff, read, as staff bring it in before the agreements.
    inStore((db) => {
      db.prepare(
        "INSERT OR REPLACE INTO kickoff (id, at, by, file_name, transcript, reading, answers) VALUES (1, ?, ?, ?, ?, ?, '{}')"
      ).run(
        atNoon(daysFromToday(-dayOfPlan - 6), 10),
        `staff:${staff.userId}`,
        "noordkade-kickoff.vtt",
        transcript,
        JSON.stringify(reading)
      );
    });

    // The agreements, which staff put in place: the leads' links go out.
    await staff.api.onboardingStaff.setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
    // Grasp's staff close the platform to the company until their go.
    await staff.api.onboardingGate.close();

    // A week gone by: the plan began seven days ago, the leads' links went
    // out on its first day and everyone else's three working days later,
    // and the interviews done by yesterday are tallied.
    const othersFrom = addWorkingDays(start, 3);
    // Leads talk in the plan's first days, everyone else after their link.
    const leadDays = pastDays.slice(0, 2);
    const otherDays = pastDays.filter((day) => day > othersFrom);
    inStore((db) => {
      db.prepare(
        "UPDATE onboarding SET plan = ?, told_at = ? WHERE id = 1"
      ).run(JSON.stringify({ start, days: planDays.usual }), atNoon(start, 9));
      const team = new Map(
        company.teams.map(({ id, lead }) => [id, lead] as const)
      );
      const link = db.prepare(
        "INSERT INTO links (person, sent_at, opened_at, led_team) VALUES (?, ?, ?, ?) ON CONFLICT (person) DO UPDATE SET sent_at = excluded.sent_at, opened_at = excluded.opened_at, led_team = excluded.led_team"
      );
      const state = db.prepare(
        "INSERT OR REPLACE INTO interview_states (person, kind, lead_of, started_at, completed_at, agreed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      db.prepare("DELETE FROM team_counts").run();
      db.prepare("DELETE FROM interview_states").run();
      const count = db.prepare(
        "INSERT INTO team_counts (team, day, asked, talked) VALUES (?, ?, ?, 0) ON CONFLICT (team, day) DO UPDATE SET asked = asked + excluded.asked"
      );
      const talkedOn = db.prepare(
        "INSERT INTO team_counts (team, day, asked, talked) VALUES (?, ?, 0, 1) ON CONFLICT (team, day) DO UPDATE SET talked = talked + 1"
      );
      let turn = 0;
      for (const [teamId, lead] of team) {
        const { talked, lead: leadTalked } = heard[teamId] ?? {
          talked: 0,
          lead: false,
        };
        let others = 0;
        for (const person of company.people) {
          if (person.team !== teamId) {
            continue;
          }
          const isLead = person.id === lead;
          const sentOn = isLead ? start : othersFrom;
          count.run(teamId, sentOn, 1);
          const talks = isLead ? leadTalked : others < talked;
          if (!isLead && talks) {
            others += 1;
          }
          const days = isLead ? leadDays : otherDays;
          const day = days[turn % days.length] ?? daysFromToday(-1);
          turn += 1;
          // Some opened their link and haven't talked yet.
          link.run(
            person.id,
            atNoon(sentOn, 9),
            talks || turn % 3 === 0 ? atNoon(sentOn, 14) : null,
            isLead ? teamId : null
          );
          if (talks) {
            const done = atNoon(day, 10 + (turn % 6));
            state.run(
              person.id,
              isLead ? "lead" : "own",
              isLead ? teamId : null,
              done,
              done,
              done,
              done
            );
            talkedOn.run(teamId, day);
          }
        }
      }
    });

    const gate = await staff.api.onboardingGate.view();
    console.info(
      `Noordkade Finance is on day ${dayOfPlan} of ${planDays.usual} of its interviews, and Grasp knows ${gate.known}% of it (the go comes at ${gate.threshold}%).`
    );
    console.info(
      `Sign in at http://localhost:5173 as ${admin.email} (${admin.name}, the company's admin) for /setup, or as ${localStaff} through Grasp's sign-in for /onboarding.`
    );
  } finally {
    adminSession.close();
    staff.close();
  }
};

try {
  await main();
} catch (error) {
  const coded =
    onboardingErrors.codeOf(error) ?? organizationErrors.codeOf(error);
  console.error(
    `The seed stopped${coded === undefined ? "" : ` (${coded})`}: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
