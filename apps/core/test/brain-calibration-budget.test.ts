import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { brainErrors } from "@grasp-os/brain/contract";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  gradeForCalibration,
  judgeInputMaxChars,
  reservedPerCallMicros,
} from "../src/knowledge/eval-judge.ts";
import { answeringGateway, fakeGateway } from "./ai-gateway.ts";
import { gatewayConfig } from "./interview-link.ts";

// Core's judge for calibrating learning suites (GRA-311, L4): a real run
// spends only what the deployment's `BRAIN_CALIBRATION_BUDGET_USD` allows,
// and nothing by default (Nick's call). The ways it can fail: a model
// called with no budget set, or past what the month and the run spent.
// AI Gateway is the outside system, faked behind the AI binding.

const request = {
  grader: { requiredChecks: [] },
  input: { task: "Do a" },
  expected: { answer: "a" },
  output: { answer: "a" },
  spent: 0,
};

/** A refusal's code, or `ok`. */
const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    return brainErrors.codeOf(error) ?? String(error);
  }
};

const before = {
  budget: env.BRAIN_CALIBRATION_BUDGET_USD,
  gateway: env.MODEL_GATEWAY,
};

describe("core's calibration judge", () => {
  afterEach(() => {
    env.BRAIN_CALIBRATION_BUDGET_USD = before.budget;
    env.MODEL_GATEWAY = before.gateway;
  });

  it("calls no model unless the deployment sets a budget, and none past it", async () => {
    env.MODEL_GATEWAY = gatewayConfig;
    const gateway = fakeGateway(
      { text: '{"verdict":"pass"}', inputTokens: 100, outputTokens: 5 },
      { text: '{"verdict":"pass"}', inputTokens: 100, outputTokens: 5 }
    );
    const ai: AiBinding = env.AI;
    const spy = vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
    try {
      env.BRAIN_CALIBRATION_BUDGET_USD = undefined;
      const unset = await codeOf(gradeForCalibration(env, request));
      env.BRAIN_CALIBRATION_BUDGET_USD = "0";
      const zero = await codeOf(gradeForCalibration(env, request));
      const callsWithout = gateway.requests.length;
      env.BRAIN_CALIBRATION_BUDGET_USD = "5";
      const graded = await gradeForCalibration(env, request);
      // The month's spend at the budget: reserved by calls under way.
      await env.DB.prepare(
        "UPDATE brain_calibration_spend SET spent_micros = 5000000"
      ).run();
      const spent = await codeOf(gradeForCalibration(env, request));
      const oversized = await codeOf(
        gradeForCalibration(env, {
          ...request,
          output: { answer: "x".repeat(judgeInputMaxChars) },
        })
      );
      expect({
        unset,
        zero,
        callsWithout,
        graded: graded.verdict,
        spent,
        oversized,
        calls: gateway.requests.length,
      }).toStrictEqual({
        unset: "brain.budget_exceeded",
        zero: "brain.budget_exceeded",
        callsWithout: 0,
        graded: "pass",
        spent: "brain.budget_exceeded",
        oversized: "brain.invalid",
        calls: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("charges a failed call in full, so a run stopped short leaves the next one held to what is left", async () => {
    env.MODEL_GATEWAY = gatewayConfig;
    // A budget of one call's reservation: the first call fails at the
    // gateway, charged in full; the next run finds nothing left.
    await env.DB.prepare("DELETE FROM brain_calibration_spend").run();
    env.BRAIN_CALIBRATION_BUDGET_USD = String(reservedPerCallMicros / 1e6);
    const gateway = answeringGateway(() => {
      throw new Error("provider down");
    });
    const ai: AiBinding = env.AI;
    const spy = vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
    try {
      const first = await codeOf(gradeForCalibration(env, request));
      const callsAfterFirst = gateway.requests.length;
      const second = await codeOf(gradeForCalibration(env, request));
      expect({
        firstFailed: first !== "ok",
        callsAfterFirst: callsAfterFirst > 0,
        second,
        callsAfterSecond: gateway.requests.length === callsAfterFirst,
      }).toStrictEqual({
        firstFailed: true,
        callsAfterFirst: true,
        second: "brain.budget_exceeded",
        callsAfterSecond: true,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
