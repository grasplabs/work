import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import {
  labAnswerSchema,
  labLinksSchema,
  labPath,
  labViaSchema,
} from "@grasp-os/shared/lab";
import type { Roster } from "@grasp-os/shared/onboarding";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import worker from "../src/index.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import {
  answering,
  careful,
  gatewayConfig,
  modelOf,
  quick,
} from "./interview-link.ts";
import {
  auditedDuring,
  routed,
  signedIn,
  signedInWithRole,
  staffPerson,
  unique,
} from "./sign-in.ts";

// The Stephen Lab's way into a local core (src/onboarding/lab.ts): its
// model calls through the gateway, and the practice people's links. AI
// Gateway is the outside system: a fake behind the AI binding. The ways it
// can fail, tried here:
//
// - A deployed core answering it: anyone could then spend a client's
//   models on the lab, or read the links it gives out.
// - Anyone but Grasp's staff using it, on a local stack too.
// - A call that goes around the gateway's allowlist, rules or audit log.

const idp = mockIdp();

/** Core's env as `vp run dev` runs it: no router in front. */
const localEnv = (): Env => ({ ...env, DEV_SKIP_ROUTER_SECRET: "true" });

/** The lab's request to a local core, as `session` signed in. */
const fromLab = async (
  body: unknown,
  { session, coreEnv = localEnv() }: { session?: string; coreEnv?: Env } = {}
): Promise<Response> =>
  await worker.fetch(
    new Request(`http://localhost:8787${labPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session === undefined ? {} : { cookie: session }),
      },
      body: JSON.stringify(body),
    }),
    coreEnv,
    createExecutionContext()
  );

const codeOf = async (response: Response) => [
  response.status,
  errorPayloadSchema.safeParse(await response.json()).data?.code ?? null,
];

/** What the lab's request answered, as JSON. */
const answerTo = async (
  body: unknown,
  options?: { session?: string }
): Promise<unknown> => {
  const response = await fromLab(body, options);
  return await response.json();
};

/** The status and code the lab's request was refused with. */
const refusedWith = async (
  body: unknown,
  options?: { session?: string }
): Promise<unknown[]> => await codeOf(await fromLab(body, options));

const staffSession = async () =>
  await signedIn(idp, "grasp-staff", staffPerson());

/** What the practice people answer, in the shape the lab asks for. */
const answerSchema = {
  type: "object",
  properties: { say: { type: "string" } },
  required: ["say"],
  additionalProperties: false,
};

const asked = {
  action: "ask",
  role: "careful",
  system: "You are Sanne, who books supplier invoices.",
  input: "Stephen: How does an invoice come in?",
  schema: answerSchema,
  maxTokens: 400,
};

describe("the Stephen Lab's way into a local core", { timeout: 60_000 }, () => {
  it("is not there on a deployed core, for staff either", async () => {
    const session = await staffSession();
    const response = await routed(labPath, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ action: "via" }),
    });
    await expect(codeOf(response)).resolves.toStrictEqual([
      404,
      "request.not_found",
    ]);
  });

  it("answers Grasp's staff only, on a local stack too", async () => {
    const member = await signedInWithRole(idp, "admin");
    const outcomes = await Promise.all([
      refusedWith({ action: "via" }),
      refusedWith({ action: "via" }, { session: member.session }),
    ]);
    expect(outcomes).toStrictEqual([
      [401, "auth.unauthenticated"],
      [403, "request.forbidden"],
    ]);
  });

  it("asks the role's model through the gateway, holds the answer to the lab's schema, and has it on record as the staff member's", async () => {
    const session = await staffSession();
    const { requests, result } = await answering(
      [
        // Not the shape asked for: the gateway asks once more.
        { text: '{"said": "by email"}', inputTokens: 300, outputTokens: 10 },
        { text: '{"say": "by email"}', inputTokens: 320, outputTokens: 10 },
      ],
      async () => {
        let response: Response | undefined;
        const audited = await auditedDuring(async () => {
          response = await fromLab(asked, { session });
        });
        return { response, audited };
      }
    );
    const answer = labAnswerSchema.parse(await result.response?.json());
    const calls = result.audited.filter(
      ({ action }) => action === "model.call"
    );
    expect({
      output: answer.output,
      model: answer.model,
      sentTo: requests.map(modelOf),
      calls: calls.map(({ actor, detail }) => ({
        actor: actor.type,
        purpose: detail.purpose,
      })),
    }).toStrictEqual({
      output: { say: "by email" },
      model: careful,
      sentTo: [
        careful.slice(careful.indexOf("/") + 1),
        careful.slice(careful.indexOf("/") + 1),
      ],
      calls: [
        { actor: "staff", purpose: "onboarding.lab" },
        { actor: "staff", purpose: "onboarding.lab" },
      ],
    });
  });

  it("refuses a call while the deployment's rules don't let the role's model take what the interviews carry", async () => {
    const session = await staffSession();
    const { requests, result } = await answering([], async () => {
      env.MODEL_GATEWAY = {
        ...gatewayConfig,
        roles: { careful },
        sensitive: { models: [quick], connections: [] },
      };
      return await refusedWith(asked, { session });
    });
    expect({ result, sent: requests.length }).toStrictEqual({
      result: [503, "model.unconfigured"],
      sent: 0,
    });
  });

  it("says how the models are reached: the gateway, and the model of each role", async () => {
    const session = await staffSession();
    const { result } = await answering([], async () =>
      labViaSchema.parse(await answerTo({ action: "via" }, { session }))
    );
    expect(result).toStrictEqual({
      gateway: gatewayConfig.gateway,
      quick: gatewayConfig.roles.quick,
      careful: gatewayConfig.roles.careful,
    });
  });

  it("gives the practice people's links, which open their interviews", async () => {
    const session = await staffSession();
    const store = onboardingStore(env);
    const person = `lab-${unique()}`;
    const roster: Roster = {
      teams: [{ id: "lab", name: "Finance", lead: null, does: "", off: false }],
      people: [
        {
          id: person,
          name: "Sanne de Vries",
          team: "lab",
          email: "",
          title: "Finance administrator",
          away: false,
        },
      ],
    };
    const by = { type: "system" } as const;
    await store.setPaused(false, by);
    await store.saveRoster(roster, by);
    await store.savePlan(
      { start: new Date().toISOString().slice(0, 10), days: 14 },
      by
    );
    await store.setAgreements(
      { processing: true, assessment: true, council: "none" },
      by
    );
    await store.releaseDue();
    const { links } = labLinksSchema.parse(
      await answerTo({ action: "links" }, { session })
    );
    const secret = links.find((each) => each.person === person)?.link;
    const opened = await routed(interviewApiPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "session",
        secret: secret?.split("#")[1] ?? "",
      }),
    });
    expect(
      z
        .object({ state: z.string(), name: z.string() })
        .parse(await opened.json())
    ).toStrictEqual({ state: "open", name: "Sanne" });
  });
});
