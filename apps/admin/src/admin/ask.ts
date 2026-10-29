/**
 * Ask Grasp (GRA-657): the admin's chat over every organization. The page
 * writes the admin's document from the organizations it shows
 * (`documentOf`, src/admin/ask-document.ts: the digest, every organization in numbers, never what
 * anyone said), as the prototype does, so a question reads no client's
 * core again; and the admin asks Grasp's own core, whose model
 * gateway answers with that deployment's rules, budgets and audit
 * (GRA-637, answer 3). The admin calls no model itself, and the browser
 * never reaches core: the question goes out signed, as the admin snapshot's
 * read does, with a key derived for this purpose alone from Grasp's own
 * client's auth secret, naming the staff member Access let in.
 *
 * Which client is Grasp's own is deployment config (`GRASP_CLIENT_ID`):
 * without it, or while that client can't be reached, the chat says which
 * of those it is and what to do next (`NotSetUp`), and asks nothing.
 */
import {
  adminAskAnswerSchema,
  adminAskMaxDocumentChars,
  adminAskPath,
  adminAskPurpose,
  adminAskRequestSchema,
  turnsOf,
} from "@grasp-os/shared/admin-ask";
import type { AdminAskRequest } from "@grasp-os/shared/admin-ask";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { z } from "zod";

import type { Staff } from "../access.ts";
import type { CoreAddress } from "../clients/core-address.ts";
import { clientGrid, routeOf } from "../clients/grid.ts";
import { deploySecrets, MissingStoreSecretError } from "../deploy/context.ts";
import type { StoreSecret } from "../deploy/context.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";

/** How long Grasp's core may take to answer: the model's own limit, and a little more. */
export const askTimeoutMs = 100_000;

/**
 * The question as the page sends it: the admin's document as it shows it
 * now, and what each side said, in order. Only Grasp's staff reach the
 * admin, and the document only goes to the model, which can do nothing
 * but answer.
 */
export const askInputSchema = z.object({
  document: z.string().max(adminAskMaxDocumentChars),
  said: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(20_000),
      })
    )
    .min(1)
    .max(200),
});

/**
 * Why Grasp's own core can't be asked, each with its own next step, as
 * the page words it:
 * - `grasp_client_unset`: no organization is named as Grasp's own
 *   (`GRASP_CLIENT_ID`);
 * - `grasp_client_unknown`: the one named isn't one the admin has;
 * - `grasp_client_not_active`: it isn't live yet, or no longer;
 * - `secret_missing`: a Secrets Store secret the question is signed with
 *   isn't there (`secret` names it);
 * - `no_client_domain`: no client domain is set, so it has no hostname;
 * - `not_routed`: the router's map has no route to it;
 * - `core_unreachable`: it runs in the dispatch namespace, and the admin
 *   has no dispatcher binding to reach it by.
 */
export type NotSetUp =
  | "grasp_client_unset"
  | "grasp_client_unknown"
  | "grasp_client_not_active"
  | "secret_missing"
  | "no_client_domain"
  | "not_routed"
  | "core_unreachable";

/**
 * Why there's no answer, as the page words it: Grasp's own core can't be
 * asked (`NotSetUp`), or
 * - `too_long`: the conversation is longer than core takes: start over;
 * - `refused`: Grasp's core turned the question away;
 * - `no_model`: Grasp's core has no model it may send the document to;
 * - `not_answered`: the model, or the request, failed or took too long.
 */
export type AskRefusal =
  | NotSetUp
  | "too_long"
  | "refused"
  | "no_model"
  | "not_answered";

/** What the chat gets back. */
export type AskAnswer =
  | { text: string; truncated: boolean; refused: null }
  | {
      text: null;
      truncated: false;
      refused: AskRefusal;
      /** For `secret_missing`, the secret's name; never a value. */
      secret?: StoreSecret;
    };

const refusal = (refused: AskRefusal, secret?: StoreSecret): AskAnswer => ({
  text: null,
  truncated: false,
  refused,
  ...(secret === undefined ? {} : { secret }),
});

const encoder = new TextEncoder();

/** Grasp's own core, and the secret to sign for it with. */
interface GraspCore {
  address: CoreAddress;
  routerSecret: string;
  authSecret: string;
}

/** The secrets a question is signed with, or the one missing from Secrets Store. */
const signingSecrets = async (
  env: Env
): Promise<DeploySecrets | { missing: StoreSecret }> => {
  try {
    return await deploySecrets(env);
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return { missing: error.secret };
    }
    throw error;
  }
};

/** Where Grasp's own core is, and the secret to sign for it with; else why it can't be asked. */
const graspCore = async (
  env: Env
): Promise<GraspCore | { notSetUp: NotSetUp; secret?: StoreSecret }> => {
  const clientId = env.GRASP_CLIENT_ID ?? "";
  if (clientId === "") {
    return { notSetUp: "grasp_client_unset" };
  }
  const grid = await clientGrid(env);
  const row = grid.find(({ id }) => id === clientId);
  if (row === undefined) {
    return { notSetUp: "grasp_client_unknown" };
  }
  if (row.status !== "active") {
    return { notSetUp: "grasp_client_not_active" };
  }
  const secrets = await signingSecrets(env);
  if ("missing" in secrets) {
    return { notSetUp: "secret_missing", secret: secrets.missing };
  }
  if (row.hostname === null) {
    return { notSetUp: "no_client_domain" };
  }
  const route = await routeOf(
    env.ROUTER_HOSTS,
    secrets.routerKey,
    row.id,
    row.hostname,
    env.DISPATCHER
  );
  if (route === "no_route") {
    return { notSetUp: "not_routed" };
  }
  // With a hostname and the router's key, only a script no dispatcher reaches.
  if (route === "unknown") {
    return { notSetUp: "core_unreachable" };
  }
  return {
    address: route.core,
    routerSecret: route.secret,
    authSecret: await clientAuthSecret(secrets, row.id, route.generation),
  };
};

/** Core's error code in an answer that isn't OK, if it gave one. */
const codeOf = async (response: Response): Promise<string | null> => {
  try {
    const body: unknown = await response.json();
    const parsed = z.object({ code: z.string() }).safeParse(body);
    return parsed.success ? parsed.data.code : null;
  } catch {
    return null;
  }
};

/**
 * `staff`'s question, with the conversation before it, answered by Grasp's
 * own core from the admin's document the page sent. Never throws for an
 * answer that didn't come.
 */
export const askGrasp = async (
  env: Env,
  staff: Pick<Staff, "email">,
  input: z.input<typeof askInputSchema>
): Promise<AskAnswer> => {
  const core = await graspCore(env);
  if ("notSetUp" in core) {
    return refusal(core.notSetUp, core.secret);
  }
  const { document, said } = askInputSchema.parse(input);
  const request: AdminAskRequest = {
    sentAt: new Date().toISOString(),
    staff: { email: staff.email },
    document,
    turns: turnsOf(said),
  };
  if (!adminAskRequestSchema.safeParse(request).success) {
    return refusal("too_long");
  }
  const body = JSON.stringify(request);
  const key = await hkdfHmacKey(core.authSecret, adminAskPurpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  );
  const limit = deadline(askTimeoutMs);
  try {
    return await Promise.race([
      (async (): Promise<AskAnswer> => {
        const response = await core.address.fetch(
          `${core.address.origin}${adminAskPath}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [routerSecretHeader]: core.routerSecret,
              [platformUpdateSignatureHeader]: signature,
            },
            body,
            // Never followed: a redirect would send the signed body and the router
            // secret wherever it points, and take what answers there for the
            // core's answer. A 3xx isn't ok, so it reads as not answered.
            redirect: "manual",
            signal: limit.signal,
          }
        );
        if (!response.ok) {
          const code = await codeOf(response);
          if (code === "admin_ask.no_model") {
            return refusal("no_model");
          }
          return refusal(
            response.status === 401 || response.status === 403
              ? "refused"
              : "not_answered"
          );
        }
        const answer = adminAskAnswerSchema.safeParse(
          await response.json().catch(() => null)
        );
        return answer.success
          ? { ...answer.data, refused: null }
          : refusal("not_answered");
      })(),
      whenAborted(limit.signal),
    ]);
  } catch {
    log.warn("admin.ask_unanswered", {
      error: limit.stopped() === "timeout" ? "timeout" : "no_answer",
    });
    return refusal("not_answered");
  } finally {
    limit.clear();
  }
};
