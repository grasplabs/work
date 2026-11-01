import { adminAskPurpose } from "@grasp-os/shared/admin-ask";
import { adminCommandAnswerSchema } from "@grasp-os/shared/admin-command";
import type { AdminCommand } from "@grasp-os/shared/admin-command";
import { adminKickoffPurpose } from "@grasp-os/shared/admin-kickoff";
import { adminSnapshotPurpose } from "@grasp-os/shared/admin-snapshot";
import { STARTING_ORG_RULES } from "@grasp-os/shared/admin/onboarding-admin";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import {
  adminCommands,
  adminSnapshot,
  commandSignature,
  commandStaff,
  deliver,
  envelopeOf,
  postCommand,
} from "./admin-command.ts";
import { mockIdp } from "./idp.ts";
import { team } from "./onboarding-team.ts";
import { signInConfig } from "./sign-in-config.ts";
import { auditedDuring, outcome, signedInApi, withSignIn } from "./sign-in.ts";

// Commands from Grasp's admin (src/admin-command.ts): every change staff
// make to a company's onboarding, from the admin. The ways it can fail,
// tried first:
//
// - Anyone but the admin, or the admin signing for another company or for
//   another purpose (the snapshot's key, the kickoff's, the chat's),
//   changing the onboarding: refused, and nothing applies.
// - A command caught on its way delivered later, or one malformed.
// - Grasp steering while the company keeps it out: no staff window, one
//   that closed, or staff access ended.
// - A command delivered twice applying twice, or twice at once; or one
//   that failed never applying when delivered again.
//
// Then that each command changes the onboarding as it says, on record by
// the staff member the admin names.

const idp = mockIdp();

const staffActor = { type: "staff", userId: commandStaff, via: "console" };

const pause: AdminCommand = { type: "onboarding.pause", payload: {} };

/** The error code of a refusal's body, if it has one. */
const codeOf = async (response: Response): Promise<string | null> => {
  const body: unknown = await response.json().catch(() => null);
  return z.object({ code: z.string() }).safeParse(body).data?.code ?? null;
};

/** What core answered, as status and code or what it applied. */
const answerOf = async (response: Response) => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      status: response.status,
      code: z.object({ code: z.string() }).safeParse(body).data?.code ?? null,
    };
  }
  return {
    status: response.status,
    applied: adminCommandAnswerSchema.parse(body).applied,
  };
};

/** Whether the interviews are paused, as the admin's snapshot says. */
const paused = async (): Promise<boolean> => {
  const snapshot = await adminSnapshot();
  return snapshot.paused;
};

/** The gate, as the admin's snapshot says. */
const gate = async () => {
  const snapshot = await adminSnapshot();
  return { open: snapshot.gate.open, threshold: snapshot.gate.threshold };
};

/** What changed, and by whom: the snapshot's own reads left out. */
const actionsBy = (events: AuditEvent[]) =>
  events
    .filter(({ action }) => action !== "admin.snapshot.read")
    .map(({ action, actor }) => ({ action, actor }));

describe("commands from Grasp's admin", { timeout: 60_000 }, () => {
  afterEach(async () => {
    await env.DB.prepare(
      "UPDATE onboarding_gate SET staff_ended_at = NULL"
    ).run();
    await onboardingStore(env).setPaused(false, { type: "system" });
  });

  it("are refused to anyone but the admin signing for this company and this purpose, stale or malformed, and apply nothing", async () => {
    const body = JSON.stringify(envelopeOf(pause));
    const stale = JSON.stringify(
      envelopeOf(pause, {
        issuedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      })
    );
    const unknownType = JSON.stringify({
      ...envelopeOf(pause),
      type: "onboarding.erase_everything",
    });
    const badPayload = JSON.stringify(
      envelopeOf({ type: "onboarding.remind", payload: { people: [] } })
    );
    const noId = JSON.stringify({ ...envelopeOf(pause), id: "again" });
    const signedFor = async (purpose: string) =>
      await commandSignature(body, env.BETTER_AUTH_SECRET, purpose);
    const tries: { body: string; signature: string | null; method?: string }[] =
      [
        { body, signature: null },
        { body, signature: "0".repeat(64) },
        // The admin's keys for the snapshot, the kickoff and the chat.
        { body, signature: await signedFor(adminSnapshotPurpose) },
        { body, signature: await signedFor(adminKickoffPurpose) },
        { body, signature: await signedFor(adminAskPurpose) },
        // Signed for another company: its own auth secret.
        {
          body,
          signature: await commandSignature(body, "another-client-auth-secret"),
        },
        { body: stale, signature: await commandSignature(stale) },
        { body: unknownType, signature: await commandSignature(unknownType) },
        { body: badPayload, signature: await commandSignature(badPayload) },
        { body: noId, signature: await commandSignature(noId) },
        { body, signature: await commandSignature(body), method: "GET" },
      ];
    const statuses: number[] = [];
    const events = await auditedDuring(async () => {
      const responses = await Promise.all(
        tries.map(
          async (each) =>
            await postCommand(each.body, {
              signature: each.signature,
              method: each.method,
            })
        )
      );
      statuses.push(...responses.map(({ status }) => status));
      await Promise.all(responses.map(async (each) => await each.text()));
    });
    expect({
      statuses,
      events: events.length,
      paused: await paused(),
    }).toStrictEqual({
      statuses: [401, 401, 401, 401, 401, 401, 403, 403, 403, 403, 404],
      events: 0,
      paused: false,
    });
  });

  it("are refused while the company keeps Grasp out, and the same command applies once it lets Grasp in again", async () => {
    const day = 24 * 60 * 60 * 1000;
    const noWindow = withSignIn({ staff: undefined });
    const closed = withSignIn({
      staff: {
        ...signInConfig.staff,
        opened: new Date(Date.now() - 3 * day).toISOString(),
        until: new Date(Date.now() - day).toISOString(),
      },
    });
    const envelope = envelopeOf(pause);
    const outside = await Promise.all([
      deliver(envelope, noWindow),
      deliver(envelope, closed),
    ]);
    const { api: admin } = await signedInApi(idp, "admin");
    await admin.onboardingGate.endStaffAccess();
    const ended = await deliver(envelope);
    const refused = await Promise.all(
      [...outside, ended].map(async (response) => ({
        status: response.status,
        code: await codeOf(response),
      }))
    );
    // The snapshot is refused while Grasp is out: the store says.
    const { paused: pausedWhileOut } = await onboardingStore(env).view();
    // The company's admin lets Grasp in again (the test's own reset).
    await env.DB.prepare(
      "UPDATE onboarding_gate SET staff_ended_at = NULL"
    ).run();
    const after = await answerOf(await deliver(envelope));
    expect({
      refused,
      pausedWhileOut,
      after,
      paused: await paused(),
    }).toStrictEqual({
      refused: Array.from({ length: 3 }, () => ({
        status: 403,
        code: "onboarding.staff_only",
      })),
      pausedWhileOut: false,
      after: { status: 200, applied: "now" },
      paused: true,
    });
  });

  it("apply a command delivered twice once, with one audit entry naming the staff member", async () => {
    const envelope = envelopeOf(pause);
    const answers: unknown[] = [];
    const events = await auditedDuring(async () => {
      answers.push(
        await answerOf(await deliver(envelope)),
        await answerOf(await deliver(envelope))
      );
    });
    expect({
      answers,
      events: actionsBy(events),
      paused: await paused(),
    }).toStrictEqual({
      answers: [
        { status: 200, applied: "now" },
        { status: 200, applied: "before" },
      ],
      events: [{ action: "onboarding.paused", actor: staffActor }],
      paused: true,
    });
  });

  // Before any test sends a link: once one went out, the team is told.
  it("keep what was agreed, and the links that are due go out at once, as the staff member", async () => {
    const store = onboardingStore(env);
    const ids = await team(["lea", "max"]);
    await store.setAgreements(
      { processing: false, assessment: false, council: "waiting" },
      { type: "system" }
    );
    const agreements = {
      processing: true,
      assessment: true,
      council: "none" as const,
      processingOn: "2026-10-01",
      assessmentOn: "2026-10-02",
    };
    const events = await auditedDuring(async () => {
      await adminCommands().setAgreements(agreements);
    });
    const snapshot = await adminSnapshot();
    // Lea's link is out, so the team is told: what was agreed stays,
    // though saving it again unchanged still applies.
    const changedLater = await outcome(
      adminCommands().setAgreements({ ...agreements, assessment: false })
    );
    const savedAgain = await outcome(adminCommands().setAgreements(agreements));
    const kept = await adminSnapshot();
    expect({
      changedLater,
      savedAgain,
      keptAgreements: kept.agreements,
      agreements: snapshot.agreements,
      agreed: snapshot.agreed,
      leaOut:
        snapshot.links.find(({ person }) => person === ids.lea)?.sentAt !==
        null,
      events: actionsBy(events).filter(
        ({ action }) => action === "onboarding.agreements.set"
      ),
    }).toStrictEqual({
      changedLater: "onboarding.agreements_kept",
      savedAgain: "ok",
      keptAgreements: agreements,
      agreements,
      agreed: true,
      leaOut: true,
      events: [{ action: "onboarding.agreements.set", actor: staffActor }],
    });
  });

  it("apply a command delivered twice at once only once", async () => {
    const { lea } = await team(["lea", "max"]);
    await onboardingStore(env).releaseDue();
    const envelope = envelopeOf({
      type: "onboarding.new_start",
      payload: { person: lea },
    });
    const answers: {
      status: number;
      applied?: string;
      code?: string | null;
    }[] = [];
    const events = await auditedDuring(async () => {
      const responses = await Promise.all([
        deliver(envelope),
        deliver(envelope),
      ]);
      answers.push(...(await Promise.all(responses.map(answerOf))));
    });
    const applied = answers.filter(({ applied: how }) => how === "now");
    const other = answers.find(({ applied: how }) => how !== "now");
    expect({
      applied: applied.length,
      // The other found it applied already, or still being applied.
      other:
        other?.applied === "before" || other?.code === "admin.command_pending",
      restarted: events.filter(
        ({ action }) => action === "onboarding.interview.restarted"
      ).length,
    }).toStrictEqual({ applied: 1, other: true, restarted: 1 });
  });

  it("let go of a command the onboarding refused, so delivering it again tries again", async () => {
    const envelope = envelopeOf({
      type: "onboarding.count_as_known",
      payload: { work: "nothing-by-this-id", counted: true },
    });
    const answers = [
      await answerOf(await deliver(envelope)),
      await answerOf(await deliver(envelope)),
    ];
    expect(answers).toStrictEqual([
      { status: 409, code: "onboarding.no_work" },
      { status: 409, code: "onboarding.no_work" },
    ]);
  });

  it("pause the interviews and let them run again, as the staff member", async () => {
    const commands = adminCommands();
    const events = await auditedDuring(async () => {
      await commands.pause();
    });
    const whilePaused = await paused();
    const resumed = await auditedDuring(async () => {
      await commands.resume();
    });
    expect({
      whilePaused,
      after: await paused(),
      events: actionsBy([...events, ...resumed]),
    }).toStrictEqual({
      whilePaused: true,
      after: false,
      events: [
        { action: "onboarding.paused", actor: staffActor },
        { action: "onboarding.resumed", actor: staffActor },
      ],
    });
  });

  it("set how much Grasp has to know, take Grasp's go back and give it, as the staff member", async () => {
    const commands = adminCommands();
    const states: { open: boolean; threshold: number }[] = [];
    const events = await auditedDuring(async () => {
      await commands.setThreshold(90);
      states.push(await gate());
      await commands.close();
      states.push(await gate());
      await commands.open();
      states.push(await gate());
    });
    await commands.setThreshold(80);
    expect({ states, events: actionsBy(events) }).toStrictEqual({
      states: [
        { open: true, threshold: 90 },
        { open: false, threshold: 90 },
        { open: true, threshold: 90 },
      ],
      events: [
        {
          action: "onboarding.gate.threshold_set",
          actor: staffActor,
        },
        { action: "onboarding.gate.closed", actor: staffActor },
        { action: "onboarding.gate.opened", actor: staffActor },
      ],
    });
  });

  it("set the organization's rules and Stephen's setup, and take both back, as the staff member", async () => {
    const commands = adminCommands();
    const rules = { ...STARTING_ORG_RULES, people: 2, minInterviews: 2 };
    const setup = {
      languages: ["nl" as const, "en" as const],
      limits: ["Payroll"],
      terms: ["Exact"],
    };
    const events = await auditedDuring(async () => {
      await commands.setRules(rules);
      await commands.saveStephen(setup);
    });
    const set = await adminSnapshot();
    await commands.setRules(null);
    await commands.saveStephen(null);
    const back = await adminSnapshot();
    expect({
      set: { rules: set.works.rules, stephen: set.setup.setup },
      back: { rules: back.works.rules, changed: back.setup.changed },
      events: actionsBy(events),
    }).toStrictEqual({
      set: { rules, stephen: setup },
      back: { rules: STARTING_ORG_RULES, changed: false },
      events: [
        { action: "onboarding.rules.set", actor: staffActor },
        { action: "onboarding.stephen.set", actor: staffActor },
      ],
    });
  });

  it("note the one reminder, ask a team in and give someone a new start, as the staff member", async () => {
    const commands = adminCommands();
    const store = onboardingStore(env);
    const ids = await team(["lea", "max"]);
    // Lea's link is out; her team waits for her.
    await store.releaseDue();
    const events = await auditedDuring(async () => {
      await commands.remind([ids.lea]);
      await commands.newStart(ids.lea);
    });
    const unknown = {
      team: await outcome(commands.askIn("nowhere")),
      mail: await outcome(commands.sendMailAgain(ids.lea)),
      noLink: await outcome(commands.newStart(ids.max)),
      work: await outcome(commands.drawWorkAgain("nothing-by-this-id")),
    };
    const { links } = await adminSnapshot();
    expect({
      reminded:
        links.find(({ person }) => person === ids.lea)?.remindedAt !== null,
      events: actionsBy(events),
      unknown,
    }).toStrictEqual({
      reminded: true,
      events: [
        { action: "onboarding.reminded", actor: staffActor },
        { action: "onboarding.interview.restarted", actor: staffActor },
      ],
      unknown: {
        team: "onboarding.no_team",
        mail: "onboarding.no_failed_mail",
        noLink: "onboarding.no_link",
        work: "onboarding.no_work",
      },
    });
  });
});
