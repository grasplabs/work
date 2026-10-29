import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import {
  modelSpendReportPath,
  modelSpendReportPurpose,
  modelSpendReportSchema,
} from "@grasp-os/shared/model-spend-report";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { quotaPolicyReportPurpose } from "@grasp-os/shared/quota-policy-report";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { budgetPeriods, monthSpend } from "../src/model-budgets.ts";
import { routed } from "./sign-in.ts";

// The deployment's model spend this month, for the admin (GRA-141): what
// the ledger charged the deployment budget the admin's ceiling sets. The
// ways it can fail, tried first: anyone but the admin reading it
// (unsigned, signed with another key or for another purpose, sent long
// ago, no request at all), and an answer other than the ledger's own.

/** `body`'s signature as the admin makes it, for `purpose`. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = modelSpendReportPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** Asks core for its spend through the router, signed with `signature`. */
const ask = async (
  body: string,
  signature: string | null,
  method = "POST"
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  return await routed(modelSpendReportPath, {
    method,
    headers,
    ...(method === "POST" ? { body } : {}),
  });
};

const bodyAt = (sentAt = new Date().toISOString()) =>
  JSON.stringify({ sentAt });

describe("the deployment's model spend, for the admin", () => {
  it("answers the admin's signed request with this month's spend as the ledger charged the deployment budget", async () => {
    const body = bodyAt();
    const response = await ask(body, await signatureOf(body));
    const { month } = budgetPeriods(env);
    const ledger = await monthSpend(env, month);

    expect({
      status: response.status,
      report: modelSpendReportSchema.parse(await response.json()),
    }).toStrictEqual({
      status: 200,
      report: { month, spent: ledger.total },
    });
  });

  it("refuses anyone but the admin: unsigned, signed otherwise or for another purpose, sent long ago, or no request at all", async () => {
    const fresh = bodyAt();
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const statuses = await Promise.all([
      ask(fresh, null),
      ask(fresh, await signatureOf(fresh, "another-secret")),
      // The quota policy report's key reads nothing here.
      ask(
        fresh,
        await signatureOf(
          fresh,
          env.BETTER_AUTH_SECRET,
          quotaPolicyReportPurpose
        )
      ),
      ask(old, await signatureOf(old)),
      ask("{}", await signatureOf("{}")),
      ask(fresh, await signatureOf(fresh), "GET"),
    ]);

    expect(statuses.map(({ status }) => status)).toStrictEqual([
      403, 403, 403, 403, 403, 404,
    ]);
  });
});
