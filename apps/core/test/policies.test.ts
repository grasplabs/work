import type { PoliciesApi, RuleInput } from "@grasp-os/shared/policies";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// The company's policies (src/policies.ts): its policy documents, rules
// and exceptions. These tests start from the ways they can fail: someone
// but the organization's own admins (Grasp staff included) changing what
// the company allows; a rule that catches every app, or names a policy
// that isn't there; an exception left behind by its rule; a policy whose
// removal takes its rules with it; a change that leaves no record, and a
// record that carries a policy's text or an exception's reason.

const idp = mockIdp();

/** Words nobody else uses, to look for where they must not be. */
const sentinel = "Peregrine confidential clause";

const handbook = {
  title: "Acceptable use of AI",
  fileName: "ai-policy.pdf",
  text: `Staff may not paste customer data into AI tools hosted outside the EU. ${sentinel}.`,
};

const outsideEu: RuleInput = {
  name: "Customer data stays in the EU",
  description: "No customer data in AI tools hosted outside the EU.",
  conditions: [
    { field: "data", values: ["customer"] },
    { field: "hosting", op: "outside", values: ["eu"] },
  ],
  effect: "block",
  status: "watching",
  policyId: null,
};

/** Each rule's status, as the book lists them. */
const statusesOf = ({ rules }: { rules: { status: string }[] }): string[] =>
  rules.map(({ status }) => status);

describe("the company's policies", () => {
  afterEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM policy_exceptions"),
      env.DB.prepare("DELETE FROM policy_rules"),
      env.DB.prepare("DELETE FROM policy_documents"),
    ]);
  });

  it("are read by everyone: a policy waits for review until an admin publishes it, without its text", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const empty = await member.api.policies.book();

    const uploaded = await admin.api.policies.upload(handbook);
    const published = await admin.api.policies.publish(uploaded.id);
    const book = await member.api.policies.book();

    expect({
      empty,
      uploaded: { status: uploaded.status, by: uploaded.uploadedBy },
      published: published.status,
      listed: book.policies.map(({ id, title, status }) => ({
        id,
        title,
        status,
      })),
    }).toStrictEqual({
      empty: { policies: [], rules: [], exceptions: [] },
      uploaded: { status: "review", by: admin.userId },
      published: "published",
      listed: [{ id: uploaded.id, title: handbook.title, status: "published" }],
    });
    expect(JSON.stringify(book)).not.toContain(sentinel);
  });

  it("take rules made by hand or from a policy that is there, each with a condition", async () => {
    const admin = await signedInApi(idp, "admin");
    const policy = await admin.api.policies.upload(handbook);

    const byHand = await admin.api.policies.createRule(outsideEu);
    const fromPolicy = await admin.api.policies.createRule({
      ...outsideEu,
      name: "From the handbook",
      policyId: policy.id,
      excerpt: "Staff may not paste customer data into AI tools",
    });
    const refused = await Promise.all([
      outcome(admin.api.policies.createRule({ ...outsideEu, conditions: [] })),
      outcome(
        admin.api.policies.createRule({
          ...outsideEu,
          policyId: "no-such-policy",
        })
      ),
      outcome(
        admin.api.policies.createRule({
          ...outsideEu,
          // SAFETY: invalid on purpose: anything a client can send, as
          // Cap'n Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          conditions: [{ field: "mood", values: ["bad"] }] as never,
        })
      ),
    ]);

    const { rules } = await admin.api.policies.book();
    expect({
      rules: rules
        .map(({ id, policyId, excerpt, createdBy }) => ({
          id,
          policyId,
          excerpt,
          createdBy,
        }))
        .toSorted((one, other) => one.id.localeCompare(other.id)),
      refused,
    }).toStrictEqual({
      rules: [
        {
          id: byHand.id,
          policyId: null,
          excerpt: undefined,
          createdBy: admin.userId,
        },
        {
          id: fromPolicy.id,
          policyId: policy.id,
          excerpt: "Staff may not paste customer data into AI tools",
          createdBy: admin.userId,
        },
      ].toSorted((one, other) => one.id.localeCompare(other.id)),
      refused: ["policy.invalid", "policy.conflict", "policy.invalid"],
    });
  });

  it("keep a removed policy's rules as made by hand, and take a removed rule's exceptions with it", async () => {
    const admin = await signedInApi(idp, "admin");
    const policy = await admin.api.policies.upload(handbook);
    const kept = await admin.api.policies.createRule({
      ...outsideEu,
      policyId: policy.id,
    });
    const gone = await admin.api.policies.createRule({
      ...outsideEu,
      name: "Gone soon",
    });
    await admin.api.policies.grantException({
      ruleId: gone.id,
      appId: "app-chatgpt",
      reason: "Pilot",
      until: "2099-01-31",
    });
    await admin.api.policies.grantException({
      ruleId: kept.id,
      appId: "app-chatgpt",
      reason: "Pilot",
      until: "2099-01-31",
    });

    await admin.api.policies.removePolicy(policy.id);
    await admin.api.policies.removeRule(gone.id);

    const book = await admin.api.policies.book();
    expect({
      policies: book.policies,
      rules: book.rules.map(({ id, policyId }) => ({ id, policyId })),
      exceptions: book.exceptions.map(({ ruleId }) => ruleId),
      again: await Promise.all([
        outcome(admin.api.policies.removeRule(gone.id)),
        outcome(admin.api.policies.publish(policy.id)),
        outcome(
          admin.api.policies.grantException({
            ruleId: gone.id,
            appId: "app-chatgpt",
            reason: "Late",
            until: "2099-01-31",
          })
        ),
      ]),
    }).toStrictEqual({
      policies: [],
      rules: [{ id: kept.id, policyId: null }],
      exceptions: [kept.id],
      again: ["policy.not_found", "policy.not_found", "policy.not_found"],
    });
  });

  it("take an exception again in place of the one before, until its day, and end it when revoked", async () => {
    const admin = await signedInApi(idp, "admin");
    const rule = await admin.api.policies.createRule(outsideEu);
    const exception = { ruleId: rule.id, appId: "app-chatgpt" };
    await admin.api.policies.grantException({
      ...exception,
      reason: "Pilot",
      until: "2099-01-31",
    });
    const again = await admin.api.policies.grantException({
      ...exception,
      reason: "Pilot, extended",
      until: "2099-03-31",
    });
    const before = await admin.api.policies.book();
    await admin.api.policies.revokeException(rule.id, "app-chatgpt");
    const after = await admin.api.policies.book();

    expect({
      again: { reason: again.reason, until: again.until },
      listed: before.exceptions.length,
      after: after.exceptions,
      invalid: await outcome(
        admin.api.policies.grantException({
          ...exception,
          reason: "Pilot",
          until: "next spring",
        })
      ),
    }).toStrictEqual({
      again: { reason: "Pilot, extended", until: "2099-03-31" },
      listed: 1,
      after: [],
      invalid: "policy.invalid",
    });
  });

  it("are changed by the organization's own admins alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const rule = await admin.api.policies.createRule(outsideEu);
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    using staffApi = core.authenticate();

    const tries = async (api: { policies: PoliciesApi }) =>
      await Promise.all([
        outcome(api.policies.upload(handbook)),
        outcome(api.policies.createRule(outsideEu)),
        outcome(
          api.policies.updateRule(rule.id, { ...outsideEu, status: "paused" })
        ),
        outcome(api.policies.removeRule(rule.id)),
        outcome(
          api.policies.grantException({
            ruleId: rule.id,
            appId: "app-chatgpt",
            reason: "Mine",
            until: "2099-01-31",
          })
        ),
      ]);

    expect({
      builder: await tries(builder.api),
      staff: await tries(staffApi),
      staffReads: await outcome(staffApi.policies.book()),
      unchanged: statusesOf(await builder.api.policies.book()),
    }).toStrictEqual({
      builder: Array.from({ length: 5 }, () => "role.forbidden"),
      staff: Array.from({ length: 5 }, () => "role.forbidden"),
      staffReads: "ok",
      unchanged: ["watching"],
    });
  });

  it("record each change by what it changed, never a policy's text or an exception's reason", async () => {
    const admin = await signedInApi(idp, "admin");
    const actor = { type: "person", userId: admin.userId };
    let policyId = "";
    let ruleId = "";
    const events = await auditedDuring(async () => {
      ({ id: policyId } = await admin.api.policies.upload(handbook));
      await admin.api.policies.publish(policyId);
      // Already published: nothing changes, nothing is recorded.
      await admin.api.policies.publish(policyId);
      ({ id: ruleId } = await admin.api.policies.createRule(outsideEu));
      await admin.api.policies.updateRule(ruleId, {
        ...outsideEu,
        status: "active",
      });
      // The same again: nothing is recorded.
      await admin.api.policies.updateRule(ruleId, {
        ...outsideEu,
        status: "active",
      });
      await admin.api.policies.grantException({
        ruleId,
        appId: "app-chatgpt",
        reason: sentinel,
        until: "2099-01-31",
      });
      await admin.api.policies.revokeException(ruleId, "app-chatgpt");
      await admin.api.policies.removeRule(ruleId);
      await admin.api.policies.removePolicy(policyId);
    });

    expect(
      events.map(({ action, actor: by, target, detail }) => ({
        action,
        by,
        target,
        detail,
      }))
    ).toStrictEqual([
      {
        action: "policy.uploaded",
        by: actor,
        target: { type: "policy", id: policyId },
        detail: {},
      },
      {
        action: "policy.published",
        by: actor,
        target: { type: "policy", id: policyId },
        detail: {},
      },
      {
        action: "policy.rule.created",
        by: actor,
        target: { type: "policy_rule", id: ruleId },
        detail: { effect: "block", status: "watching" },
      },
      {
        action: "policy.rule.updated",
        by: actor,
        target: { type: "policy_rule", id: ruleId },
        detail: { effect: "block", status: "active" },
      },
      {
        action: "policy.exception.granted",
        by: actor,
        target: { type: "policy_rule", id: ruleId },
        detail: { appId: "app-chatgpt", until: "2099-01-31" },
      },
      {
        action: "policy.exception.revoked",
        by: actor,
        target: { type: "policy_rule", id: ruleId },
        detail: { appId: "app-chatgpt" },
      },
      {
        action: "policy.rule.removed",
        by: actor,
        target: { type: "policy_rule", id: ruleId },
        detail: {},
      },
      {
        action: "policy.removed",
        by: actor,
        target: { type: "policy", id: policyId },
        detail: {},
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });
});
