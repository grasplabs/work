import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { onboardingSummaryPurpose } from "@grasp-os/shared/onboarding-summary";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import {
  quotaLimitsHash,
  quotaLimitsSchema,
} from "@grasp-os/shared/quota-policy";
import {
  quotaPolicyReportPath,
  quotaPolicyReportPurpose,
  quotaPolicyReportSchema,
} from "@grasp-os/shared/quota-policy-report";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { quotaPolicy, recordGeneration } from "../src/workflows/quotas.ts";
import { allEvents } from "./audit-events.ts";
import { lastGeneration, nextPolicy, withQuotas } from "./quota-policies.ts";
import { routed } from "./sign-in.ts";

// The quota policy core applies, for the console (GRA-600), and the audit
// trail of each generation core records. The ways it can fail, tried
// first: anyone but the console reading it (unsigned, signed with another
// key or for another purpose, sent long ago, no request at all), and the
// trail logging a generation twice, or one core never recorded.

/** `body`'s signature as the console makes it, for `purpose`. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = quotaPolicyReportPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** Asks core for its policy through the router, signed with `signature`. */
const ask = async (
  body: string,
  signature: string | null,
  method = "POST"
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  return await routed(quotaPolicyReportPath, {
    method,
    headers,
    ...(method === "POST" ? { body } : {}),
  });
};

const bodyAt = (sentAt = new Date().toISOString()) =>
  JSON.stringify({ sentAt });

/** The audit events recording generation `generation`. */
const recordedEvents = async (generation: number) => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "quota_policy.recorded" && target?.id === String(generation)
  );
};

describe("the quota policy core applies", () => {
  it("answers the console's signed request with the generation in force, what it lowers and when core recorded it", async () => {
    const answer = await withQuotas({ workflowSteps: 5 }, async () => {
      const body = bodyAt();
      const response = await ask(body, await signatureOf(body));
      return {
        status: response.status,
        report: quotaPolicyReportSchema.parse(await response.json()),
        generation: lastGeneration(),
      };
    });
    expect({
      status: answer.status,
      generation: answer.report.generation === answer.generation,
      lowered: answer.report.lowered,
      // The hash the console computes of the limits it deployed.
      limitsHash:
        answer.report.limitsHash ===
        (await quotaLimitsHash({ workflowSteps: 5 })),
      recorded: answer.report.recordedAt !== null,
    }).toStrictEqual({
      status: 200,
      generation: true,
      lowered: { workflowSteps: 5 },
      limitsHash: true,
      recorded: true,
    });
  });

  it("refuses anyone but the console: unsigned, signed otherwise or for another purpose, sent long ago, or no request at all", async () => {
    const fresh = bodyAt();
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const statuses = await Promise.all([
      ask(fresh, null),
      ask(fresh, await signatureOf(fresh, "another-secret")),
      // The onboarding summary's key reads nothing here.
      ask(
        fresh,
        await signatureOf(
          fresh,
          env.BETTER_AUTH_SECRET,
          onboardingSummaryPurpose
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

  it("records each generation in the audit log once, as it records it, and none it refuses", async () => {
    const configured = env.QUOTA_LIMITS;
    const newer = nextPolicy({ workflowSteps: 7 });
    env.QUOTA_LIMITS = newer;
    // Isolates seeing it at once: one records it, and logs it.
    await Promise.all([quotaPolicy(env), quotaPolicy(env), quotaPolicy(env)]);
    await quotaPolicy(env);
    const recorded = await recordedEvents(newer.generation);
    // An older generation, and another policy under the newest: refused,
    // never recorded.
    env.QUOTA_LIMITS = { generation: newer.generation - 1, limits: {} };
    await quotaPolicy(env);
    env.QUOTA_LIMITS = {
      generation: newer.generation,
      limits: { workflowSteps: 6 },
    };
    await quotaPolicy(env);
    const refused = [
      ...(await recordedEvents(newer.generation - 1)),
      ...(await recordedEvents(newer.generation)),
    ];
    // The deployment's own limits again, under a newer generation still.
    env.QUOTA_LIMITS = nextPolicy(quotaLimitsSchema.parse(configured).limits);
    await quotaPolicy(env);
    expect({
      recorded: recorded.map(({ detail }) => ({
        generation: detail?.generation,
        workflowSteps: detail?.workflowSteps,
      })),
      refused: refused.length,
    }).toStrictEqual({
      recorded: [{ generation: newer.generation, workflowSteps: 7 }],
      // Only the one recording of the newest.
      refused: 1,
    });
  });

  it("records nothing, and logs nothing, of a generation an isolate read as newest after a newer one went in", async () => {
    const configured = env.QUOTA_LIMITS;
    // A generation never deployed, then a newer one.
    const skipped = nextPolicy({});
    const newer = nextPolicy({ workflowSteps: 9 });
    env.QUOTA_LIMITS = newer;
    await quotaPolicy(env);
    // An isolate that read the highest before `newer` was recorded, and
    // records the generation before it.
    const stale = { generation: skipped.generation, limits: {} };
    await recordGeneration(env, stale, "{}", "stale-hash");
    const row = await env.DB.prepare(
      "SELECT generation FROM quota_policies WHERE generation = ?"
    )
      .bind(stale.generation)
      .first();
    const logged = await recordedEvents(stale.generation);
    env.QUOTA_LIMITS = nextPolicy(quotaLimitsSchema.parse(configured).limits);
    await quotaPolicy(env);
    expect({ row, logged: logged.length }).toStrictEqual({
      row: null,
      logged: 0,
    });
  });
});
