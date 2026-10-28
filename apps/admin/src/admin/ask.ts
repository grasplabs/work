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
 * without it, or while that client isn't deployed, the chat says it isn't
 * set up and asks nothing.
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
import { clientGrid, ifStored, routeOf } from "../clients/grid.ts";
import { deploySecrets } from "../deploy/context.ts";
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
 * Why there's no answer, as the page words it:
 * - `not_set_up`: no client is named as Grasp's own, or it isn't deployed;
 * - `too_long`: the conversation is longer than core takes: start over;
 * - `refused`: Grasp's core turned the question away;
 * - `no_model`: Grasp's core has no model it may send the document to;
 * - `not_answered`: the model, or the request, failed or took too long.
 */
export type AskRefusal =
  | "not_set_up"
  | "too_long"
  | "refused"
  | "no_model"
  | "not_answered";

/** What the chat gets back. */
export type AskAnswer =
  | { text: string; truncated: boolean; refused: null }
  | { text: null; truncated: false; refused: AskRefusal };

const refusal = (refused: AskRefusal): AskAnswer => ({
  text: null,
  truncated: false,
  refused,
});

const encoder = new TextEncoder();

/** Where Grasp's own core is, and the secret to sign for it with; null when it can't be asked. */
const graspCore = async (
  env: Env
): Promise<{
  address: CoreAddress;
  routerSecret: string;
  authSecret: string;
} | null> => {
  const clientId = env.GRASP_CLIENT_ID ?? "";
  if (clientId === "") {
    return null;
  }
  const grid = await clientGrid(env);
  const row = grid.find(
    ({ id, status }) => id === clientId && status === "active"
  );
  const secrets = await ifStored(
    async (): Promise<DeploySecrets> => await deploySecrets(env)
  );
  if (row === undefined || secrets === null) {
    return null;
  }
  const route = await routeOf(
    env.ROUTER_HOSTS,
    secrets.routerKey,
    row.id,
    row.hostname,
    env.DISPATCHER
  );
  if (route === "no_route" || route === "unknown") {
    return null;
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
  if (core === null) {
    return refusal("not_set_up");
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
