import type { AuditEvent } from "@grasp-os/shared/audit";
import { noChoices } from "@grasp-os/shared/onboarding-choices";
import { defaultFlow, flowSteps } from "@grasp-os/shared/onboarding-flow";
import type {
  FlowStep,
  OnboardingFlow,
} from "@grasp-os/shared/onboarding-flow";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import {
  adminCommands,
  adminSnapshot,
  commandSignature,
  commandStaff,
  envelopeOf,
  postCommand,
} from "./admin-command.ts";
import { team } from "./onboarding-team.ts";
import { auditedDuring, outcome } from "./sign-in.ts";

// How much onboarding a company goes through (`onboarding.flow`, a
// command from Grasp's admin; src/admin-command.ts tries who may give a
// command at all). The ways the flow itself can go wrong, tried first:
//
// - A flow that can't work kept anyway: team leads or the interviews
//   before who's who, or without it, or a step left out.
// - The interviews taken out once the team is told, by switching them
//   off or the whole onboarding: people were told they'd be heard.
// - An interview link going out before an agreement the company is asked
//   for is in; or waiting for one it isn't asked for.
// - What the admin gave on a step lost when the step is switched off.
//
// Then that a flow is kept as given and taken back, on record by the
// staff member the admin names.
//
// The tests run in order: the last one sends a link, which tells the team.

const staffActor = { type: "staff", userId: commandStaff, via: "console" };
const system = { type: "system" } as const;

/** The flow's steps in order, with those in `off` switched off. */
const stepsOf = (off: readonly FlowStep[] = []) =>
  flowSteps.map((id) => ({ id, on: !off.includes(id) }));

/** The flow as the admin's snapshot says it. */
const flowNow = async () => {
  const snapshot = await adminSnapshot();
  return snapshot.flow;
};

/** What changed about the flow, and by whom. */
const flowChanges = (events: AuditEvent[]) =>
  events
    .filter(({ action }) => action.startsWith("onboarding.flow."))
    .map(({ action, actor }) => ({ action, actor }));

describe("a company's onboarding flow", { timeout: 60_000 }, () => {
  it("is all of it until staff set one, is kept as they set it and taken back, as the staff member", async () => {
    const commands = adminCommands();
    const before = await flowNow();
    // A short one: no story, no documents, no interviews, no kickoff.
    const short: OnboardingFlow = {
      on: true,
      steps: stepsOf(["about", "documents", "pulse", "interviews"]),
      grasp: {
        kickoff: false,
        agreements: { processing: true, assessment: false, council: false },
      },
    };
    const events = await auditedDuring(async () => {
      await commands.setFlow(short);
    });
    const set = await flowNow();
    const off = await outcome(commands.setFlow({ ...defaultFlow, on: false }));
    const switchedOff = await flowNow();
    const back = await auditedDuring(async () => {
      await commands.setFlow(null);
    });
    expect({
      before,
      set,
      off,
      switchedOff: switchedOff?.flow.on,
      after: await flowNow(),
      events: flowChanges([...events, ...back]),
    }).toStrictEqual({
      before: { flow: defaultFlow, changed: false },
      set: { flow: short, changed: true },
      off: "ok",
      switchedOff: false,
      after: { flow: defaultFlow, changed: false },
      events: [
        { action: "onboarding.flow.set", actor: staffActor },
        { action: "onboarding.flow.reset", actor: staffActor },
      ],
    });
  });

  it("refuses a flow that can't work, and keeps the one it had", async () => {
    const leadsFirst = [...stepsOf()].toSorted(
      (one, other) => Number(other.id === "leads") - Number(one.id === "leads")
    );
    const tries: unknown[] = [
      { ...defaultFlow, steps: leadsFirst },
      // The interviews without who's who.
      { ...defaultFlow, steps: stepsOf(["company"]) },
      { ...defaultFlow, steps: stepsOf().slice(1) },
      { ...defaultFlow, steps: [...stepsOf(), { id: "payroll", on: true }] },
      { on: true },
    ];
    // As raw bodies, signed as the admin signs: what its own types would never send.
    const answers = await Promise.all(
      tries.map(async (flow) => {
        const body = JSON.stringify({
          ...envelopeOf({ type: "onboarding.pause", payload: {} }),
          type: "onboarding.flow",
          payload: { flow },
        });
        const response = await postCommand(body, {
          signature: await commandSignature(body),
        });
        return response.status;
      })
    );
    expect({
      refused: answers.every((status) => status >= 400 && status < 500),
      kept: await flowNow(),
    }).toStrictEqual({
      refused: true,
      kept: { flow: defaultFlow, changed: false },
    });
  });

  it("keeps what the admin gave on a step that is switched off", async () => {
    const store = onboardingStore(env);
    const choices = { ...noChoices, sources: ["sharepoint" as const] };
    await store.saveChoices(choices, system);
    await adminCommands().setFlow({
      ...defaultFlow,
      steps: stepsOf(["sources"]),
    });
    const kept = await store.choices();
    await adminCommands().setFlow(null);
    expect(kept).toStrictEqual(choices);
  });

  it("sends links once the agreements the flow asks for are in, and keeps the interviews once the team is told", async () => {
    const store = onboardingStore(env);
    const commands = adminCommands();
    const ids = await team(["lea", "max"]);
    await store.setAgreements(
      { processing: false, assessment: false, council: "waiting" },
      system
    );
    const leaOut = async () => {
      const snapshot = await adminSnapshot();
      return {
        agreed: snapshot.agreed,
        out:
          snapshot.links.find(({ person }) => person === ids.lea)?.sentAt !==
          null,
      };
    };
    // Only the processing agreement is asked of this company.
    const onlyProcessing: OnboardingFlow = {
      ...defaultFlow,
      grasp: {
        kickoff: true,
        agreements: { processing: true, assessment: false, council: false },
      },
    };
    await commands.setFlow(onlyProcessing);
    const waiting = await leaOut();
    await commands.setAgreements({
      processing: true,
      assessment: false,
      council: "waiting",
    });
    const sent = await leaOut();

    // Lea's link is out, so the team is told.
    const noInterviews = await outcome(
      commands.setFlow({ ...onlyProcessing, steps: stepsOf(["interviews"]) })
    );
    const noOnboarding = await outcome(
      commands.setFlow({ ...onlyProcessing, on: false })
    );
    const otherSteps = await outcome(
      commands.setFlow({ ...onlyProcessing, steps: stepsOf(["pulse"]) })
    );
    const kept = await flowNow();
    expect({
      waiting,
      sent,
      noInterviews,
      noOnboarding,
      otherSteps,
      interviewsKept: kept?.flow.steps.find(({ id }) => id === "interviews"),
    }).toStrictEqual({
      waiting: { agreed: false, out: false },
      sent: { agreed: true, out: true },
      noInterviews: "onboarding.interviews_kept",
      noOnboarding: "onboarding.interviews_kept",
      otherSteps: "ok",
      interviewsKept: { id: "interviews", on: true },
    });
  });
});
