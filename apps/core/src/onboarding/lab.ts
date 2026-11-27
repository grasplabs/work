import { actorOf } from "@grasp-os/shared/audit";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { labMaxBytes, labRequestSchema } from "@grasp-os/shared/lab";
import type {
  LabAnswer,
  LabContext,
  LabDrawings,
  LabInterview,
  LabLinks,
  LabRequest,
  LabVia,
} from "@grasp-os/shared/lab";
import { modelErrors } from "@grasp-os/shared/models";
import { companyNameOf } from "@grasp-os/shared/organization";
import type { Identity } from "@grasp-os/shared/rpc";
import { z } from "zod";

import { identify } from "../auth/identity.ts";
import { errorResponse } from "../errors.ts";
import { modelSettings, modelForRole, models } from "../models.ts";
import { readOrganization } from "../organization.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { isLocalDevRequest } from "../router-secret.ts";
import { auditStaffRoute } from "../staff-audit.ts";
import { turnStream } from "./lab-turn.ts";
import { onboardingStore } from "./store.ts";

// The Stephen Lab's way into a local core, `POST /api/lab` (GRA-337): the
// lab (scripts/lab/) plays the people Stephen interviews and judges what
// he wrote down, with models, and those calls go through the model gateway
// here, as every model call does: allowed models only, the deployment's
// rules, the budgets and the audit log. The lab holds no provider key, and
// no bridge to anyone's subscription: what it measures is reached the way
// the interviews themselves are.
//
// Stephen's turns, turn by turn, are the lab's alone (lab-turn.ts): every
// interview is a live conversation with Grasp's agent, and no link
// reaches a turn. The benches (GRA-338) give a turn fixed input, with who
// it is with given; an interview the lab plays names the practice person
// it is with, known as the store knows them. A drawing is drawn again from
// what was agreed and kept nowhere. Neither is counted by the onboarding:
// they are the lab's, not anyone's interview.
//
// It answers on a local stack only (`vp run dev`, the same requests the
// router-secret check lets through there), and only Grasp's staff: on a
// deployed core the route isn't there, so no one can spend a client's
// models on the lab, or read the links it gives out, or what the practice
// people it played said (`interview`): Grasp's staff read no word of a
// client's interviews (GRA-329).

/** Why the gateway is asked, for the audit log. */
const purpose = "onboarding.lab";

/** The same sites `fetch` reports for a request a page of our own made, or none at all. */
const sameSiteFetches = new Set(["same-origin", "none"]);

/** How the local core reaches its models, as the lab labels every result with it. */
const viaOf = async (env: Env): Promise<LabVia> => {
  const settings = await modelSettings(env);
  if (settings.models.length === 0) {
    return { quick: null, careful: null };
  }
  return {
    quick: modelForRole(settings, "quick"),
    careful: modelForRole(settings, "careful"),
  };
};

/** A gateway refusal, as the lab reads it: busy is worth a retry, the rest isn't. */
const refusalResponse = (error: unknown, requestId: string): Response => {
  const code = modelErrors.codeOf(error) ?? "model.failed";
  const status = code === "model.rate_limited" ? 429 : 502;
  return errorResponse(status, modelErrors.create(code), requestId);
};

/** One call through the gateway, by the model the deployment named for `role`. */
const ask = async (
  env: Env,
  person: Identity,
  asked: Extract<LabRequest, { action: "ask" }>,
  requestId: string
): Promise<Response> => {
  const settings = await modelSettings(env);
  if (settings.models.length === 0) {
    return errorResponse(
      503,
      modelErrors.create("model.no_provider"),
      requestId
    );
  }
  const model = modelForRole(settings, asked.role);
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(asked.schema);
  } catch {
    return errorResponse(
      400,
      modelErrors.create("model.invalid_call"),
      requestId
    );
  }
  try {
    const answer = await models(env).call({
      model,
      purpose,
      trigger: actorOf(person),
      // What a practice company's people say is played, not a client's,
      // but it is judged as the interviews are: as sensitive data, by the
      // models the rules allow for that.
      work: { onboarding: true },
      requestId,
      system: asked.system,
      input: asked.input,
      schema,
      maxTokens: asked.maxTokens,
      effort: asked.effort ?? "low",
    });
    const answered: LabAnswer = {
      output: z.json().parse(answer.output),
      model,
      usage: {
        inputTokens: answer.usage.inputTokens,
        outputTokens: answer.usage.outputTokens,
      },
      cost: answer.cost,
    };
    return Response.json(answered);
  } catch (error) {
    return refusalResponse(error, requestId);
  }
};

/** Everyone's link, as the onboarding would send it, whether it is out yet or not. */
const links = async (env: Env): Promise<Response> => {
  const store = onboardingStore(env);
  const { roster } = await store.view();
  const all = await Promise.all(
    (roster?.people ?? []).map(async ({ id }) => ({
      person: id,
      link: await store.linkOf(id),
    }))
  );
  const answered: LabLinks = {
    links: all.flatMap(({ person, link }) =>
      link === null ? [] : [{ person, link }]
    ),
  };
  return Response.json(answered);
};

/**
 * One of Stephen's turns: on fixed input, someone's own interview with
 * who it is with given, or with someone on the roster the lab plays.
 */
const turn = async (
  env: Env,
  asked: Extract<LabRequest, { action: "turn" }>,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response> => {
  if ("person" in asked.who) {
    const [found, organization] = await Promise.all([
      onboardingStore(env).contextOf(asked.who.person),
      readOrganization(env),
    ]);
    if (found === null) {
      return errorResponse(
        404,
        requestErrors.create("request.not_found"),
        requestId
      );
    }
    return await turnStream({
      env,
      turn: asked.turn,
      context: found,
      company: Promise.resolve(
        companyNameOf(organization.name, organization.signInDomains) ?? ""
      ),
      requestId,
      ctx,
    });
  }
  const { company, ...who } = asked.who;
  return await turnStream({
    env,
    turn: asked.turn,
    context: { ...who, kind: "own", terms: [] },
    company: Promise.resolve(company),
    requestId,
    ctx,
  });
};

/** Who someone is, as a turn of theirs would know it. */
const context = async (env: Env, person: string): Promise<Response> => {
  const [found, organization] = await Promise.all([
    onboardingStore(env).contextOf(person),
    readOrganization(env),
  ]);
  const answered: LabContext = {
    who:
      found === null
        ? null
        : {
            company:
              companyNameOf(organization.name, organization.signInDomains) ??
              "",
            name: found.name,
            team: found.team,
            lead: found.lead,
            work: found.work,
            known: found.known,
          },
  };
  return Response.json(answered);
};

/** Every piece of work, drawn again. */
const drawings = async (env: Env, requestId: string): Promise<Response> => {
  try {
    const answered: LabDrawings = {
      drawings: await onboardingStore(env).drawnAgain(),
    };
    return Response.json(answered);
  } catch (error) {
    return refusalResponse(error, requestId);
  }
};

/** The lab's request, on a local stack, from Grasp's staff. */
export const labResponse = async (
  request: Request,
  env: Env,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response> => {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    !isLocalDevRequest(request, env) ||
    request.method !== "POST" ||
    (fetchSite !== null && !sameSiteFetches.has(fetchSite))
  ) {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const person = await identify(env, request.headers);
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  // A staff member's view is in the client's audit log (staff-audit.ts).
  await auditStaffRoute(env, person, "onboarding.lab");
  if (!person.staff) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const raw = await boundedText(request.body, labMaxBytes);
  const parsed = labRequestSchema.safeParse(
    raw === undefined ? undefined : jsonOf(raw)
  );
  if (!parsed.success) {
    return errorResponse(
      400,
      modelErrors.create("model.invalid_call"),
      requestId
    );
  }
  const asked = parsed.data;
  if (asked.action === "links") {
    return await links(env);
  }
  if (asked.action === "via") {
    return Response.json(await viaOf(env));
  }
  if (asked.action === "turn") {
    return await turn(env, asked, requestId, ctx);
  }
  if (asked.action === "context") {
    return await context(env, asked.person);
  }
  if (asked.action === "draw") {
    return await drawings(env, requestId);
  }
  if (asked.action === "interview") {
    const answered: LabInterview = {
      interview: await onboardingStore(env).practiceInterviewOf(asked.person),
    };
    return Response.json(answered);
  }
  return await ask(env, person, asked, requestId);
};
