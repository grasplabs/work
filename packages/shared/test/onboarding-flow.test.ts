import { describe, expect, it } from "vite-plus/test";

import {
  defaultFlow,
  flowAgreementsOf,
  flowOpening,
  flowPresets,
  flowScreens,
  flowInterviews,
  flowProblemOf,
  flowSteps,
  onboardingFlowSchema,
  setupSteps,
  storedFlowOf,
  withStepMoved,
} from "../src/onboarding-flow.ts";
import type { FlowStep, OnboardingFlow } from "../src/onboarding-flow.ts";
import { knownPercent, knownSourcesOf } from "../src/onboarding-gate.ts";

/** The default flow's steps in `order`, with those in `off` switched off. */
const stepsOf = (
  order: readonly FlowStep[] = flowSteps,
  off: readonly FlowStep[] = []
) => order.map((id) => ({ id, on: !off.includes(id) }));

/** The default flow's steps with `one` moved to just before `other`. */
const moved = (one: FlowStep, other: FlowStep): FlowStep[] => {
  const rest = flowSteps.filter((step) => step !== one);
  const at = rest.indexOf(other);
  return [...rest.slice(0, at), one, ...rest.slice(at)];
};

/** A source that counts for ten, with `known` of it in. */
const weighed = (known: number) => ({ weight: 10, known });

/** A flow's steps by name, in its order. */
const order = (flow: OnboardingFlow) => flow.steps.map(({ id }) => id);

describe("an onboarding flow", () => {
  it("is everything, in order, for a company whose flow nobody set", () => {
    expect({
      valid: onboardingFlowSchema.safeParse(defaultFlow).success,
      steps: defaultFlow.steps.filter(({ on }) => on).map(({ id }) => id),
      interviews: flowInterviews(defaultFlow),
      agreements: flowAgreementsOf(defaultFlow),
    }).toStrictEqual({
      valid: true,
      steps: [...flowSteps],
      interviews: true,
      agreements: ["processing", "assessment", "council"],
    });
  });

  it("takes its steps in any order and any of them off, as long as who's who comes before what needs the staff list", () => {
    expect({
      reordered: flowProblemOf(stepsOf(moved("documents", "welcome"))),
      onlyAi: flowProblemOf(
        stepsOf(
          flowSteps,
          flowSteps.filter((step) => step !== "ai")
        )
      ),
      // Who's who off is fine once nothing needs the staff list.
      noStaffList: flowProblemOf(
        stepsOf(flowSteps, ["company", "leads", "interviews"])
      ),
      leadsFirst: flowProblemOf(stepsOf(moved("leads", "company"))),
      interviewsFirst: flowProblemOf(stepsOf(moved("interviews", "company"))),
      leadsWithout: flowProblemOf(stepsOf(flowSteps, ["company"])),
      // Off, a step can stand anywhere.
      leadsFirstButOff: flowProblemOf(
        stepsOf(moved("leads", "company"), ["leads"])
      ),
    }).toStrictEqual({
      reordered: null,
      onlyAi: null,
      noStaffList: null,
      leadsFirst: "staff_list",
      interviewsFirst: "staff_list",
      leadsWithout: "staff_list",
      leadsFirstButOff: null,
    });
  });

  it("names every step once", () => {
    const [first, ...rest] = stepsOf();
    expect({
      missing: flowProblemOf(rest),
      twice: flowProblemOf(
        first === undefined ? rest : [first, first, ...rest.slice(1)]
      ),
      unknown: onboardingFlowSchema.safeParse({
        ...defaultFlow,
        steps: [{ id: "payroll", on: true }, ...rest],
      }).success,
      outOfOrder: onboardingFlowSchema.safeParse({
        ...defaultFlow,
        steps: stepsOf(moved("leads", "company")),
      }).success,
    }).toStrictEqual({
      missing: "steps",
      twice: "steps",
      unknown: false,
      outOfOrder: false,
    });
  });

  it("reads a kept flow back, and one that can't be read as all of it", () => {
    const short: OnboardingFlow = {
      ...defaultFlow,
      steps: stepsOf(flowSteps, ["pulse"]),
    };
    expect({
      kept: storedFlowOf(JSON.stringify(short)),
      none: storedFlowOf(null),
      // Kept before a step was added: one short.
      stale: storedFlowOf(
        JSON.stringify({ ...short, steps: short.steps.slice(1) })
      ),
      broken: storedFlowOf("{"),
    }).toStrictEqual({
      kept: { flow: short, set: true },
      none: { flow: defaultFlow, set: false },
      stale: { flow: defaultFlow, set: false },
      broken: { flow: defaultFlow, set: false },
    });
  });

  it("interviews nobody and asks for no agreement where the onboarding is off", () => {
    const off: OnboardingFlow = { ...defaultFlow, on: false };
    const noInterviews: OnboardingFlow = {
      ...defaultFlow,
      steps: stepsOf(flowSteps, ["interviews"]),
      grasp: {
        kickoff: false,
        agreements: { processing: true, assessment: false, council: false },
      },
    };
    expect({
      off: [flowInterviews(off), flowAgreementsOf(off)],
      noInterviews: [
        flowInterviews(noInterviews),
        flowAgreementsOf(noInterviews),
      ],
    }).toStrictEqual({
      off: [false, []],
      noInterviews: [false, ["processing"]],
    });
  });

  it("asks for the sources its steps give, so what Grasp knows is a share of what is asked", () => {
    const short: OnboardingFlow = {
      ...defaultFlow,
      steps: stepsOf(flowSteps, ["documents", "pulse", "interviews"]),
      grasp: { ...defaultFlow.grasp, kickoff: false },
    };
    expect({
      whole: knownSourcesOf(defaultFlow),
      short: knownSourcesOf(short),
      off: knownSourcesOf({ ...defaultFlow, on: false }),
      half: knownPercent([weighed(1), weighed(0)]),
      thirds: knownPercent([weighed(1), weighed(1), weighed(0)]),
      nothingAsked: knownPercent([]),
    }).toStrictEqual({
      whole: [
        "kickoff",
        "people",
        "sources",
        "documents",
        "tools",
        "leads",
        "conversations",
        "review",
      ],
      short: ["people", "sources", "leads"],
      off: [],
      half: 50,
      thirds: 67,
      nothingAsked: 100,
    });
  });

  it("starts from presets that all work, each with its own way of opening", () => {
    expect(
      Object.entries(flowPresets).map(([name, flow]) => [
        name,
        onboardingFlowSchema.safeParse(flow).success,
        flowScreens(flow),
        flowOpening(flow),
      ])
    ).toStrictEqual([
      ["full", true, [...setupSteps], "go"],
      [
        "short",
        true,
        [
          "welcome",
          "ai",
          "company",
          "leads",
          "team",
          "listening",
          "review",
          "open",
        ],
        "go",
      ],
      [
        "setup",
        true,
        ["welcome", "ai", "company", "sources", "documents"],
        "finished",
      ],
      ["none", true, [], "at_once"],
    ]);
  });

  it("puts the interviews' screens last, wherever the flow has the step", () => {
    const early = withStepMoved(defaultFlow, "interviews", 4);
    expect({
      step: order(early)[4],
      screens: flowScreens(early).slice(-5),
    }).toStrictEqual({
      step: "interviews",
      screens: ["leads", "team", "listening", "review", "open"],
    });
  });

  it("moves a step to another place, the others keeping their order", () => {
    expect({
      first: order(withStepMoved(defaultFlow, "documents", 0)).slice(0, 3),
      last: order(withStepMoved(defaultFlow, "welcome", 99)).at(-1),
      same: order(withStepMoved(defaultFlow, "ai", 1)),
      // Opens at once with every step off, too.
      allOff: flowOpening({
        ...defaultFlow,
        steps: stepsOf(flowSteps, flowSteps),
      }),
    }).toStrictEqual({
      first: ["documents", "welcome", "ai"],
      last: "welcome",
      same: [...flowSteps],
      allOff: "at_once",
    });
  });
});
