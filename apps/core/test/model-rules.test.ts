import { appIdSchema } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import type { ModelCall } from "../src/models.ts";
import { mockIdp } from "./idp.ts";
import { anthropic, withRules, eventsOf, callsInAnApp } from "./model-rules.ts";
import { outcome } from "./sign-in.ts";

// The client's rules for model calls, checked on every call before
// anything is sent: which models, and in which work context. The model
// provider behind connect is the outside system (test/model-provider.ts).
// Everything else is real, down to the audit log.
//
// The rules a JSON workflow's model call meets are tried where its runs
// are: a start refused until an admin approves its model binding, and its
// call refused once the approval is revoked (workflow-bindings' "list a
// live version's unapproved bindings for admins…" and "needs an approval
// for each catalog binding, freezes it, and is refused once it is
// revoked…", workflow-model-calls' "refuses the next model call once its
// approval is revoked"). Only App workflows had the rest, and they go with them: an
// AI step through an App's model resource and its structured output, a run
// pinned to an App version whose alias was rebound, a version made current
// past activation, and an AI step's retry taking the answer its timed-out
// attempt left (a JSON model task is tried once, resource-calls.ts).

const idp = mockIdp();

describe("model rules", () => {
  const hello = callsInAnApp(idp);

  it("audit a model the organization didn't choose as refused", async () => {
    const { call } = await withRules();
    const refused = hello("anthropic/claude-opus-4-1");

    await expect(outcome(call(refused))).resolves.toBe("model.not_allowed");
    await expect(eventsOf(refused.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: {
          reason: "model.not_allowed",
          because: null,
          model: "anthropic/claude-opus-4-1",
          provenanceDropped: 0,
        },
      },
    ]);
  });

  it("record a refusal whose provenance is too large for the audit log, with as much of it as fits", async () => {
    const { call } = await withRules();
    // A hundred identifiers of 256 three-byte characters: 77 KB.
    const provenance = Array.from({ length: 100 }, (_, index) =>
      `${index}`.padEnd(256, "€")
    );
    const refused = hello("anthropic/claude-opus-4-1", { provenance });

    await expect(outcome(call(refused))).resolves.toBe("model.not_allowed");
    const [event, ...more] = await eventsOf(refused.trigger);
    const kept = event?.provenance.length ?? 0;
    expect({
      more: more.length,
      kept: kept > 0 && kept < 100,
      provenance: event?.provenance,
      dropped: event?.detail.provenanceDropped,
    }).toStrictEqual({
      more: 0,
      kept: true,
      provenance: provenance.slice(0, kept),
      dropped: 100 - kept,
    });
  });

  it("refuse and audit a call that claims to work in another App's context", async () => {
    const { fake, call } = await withRules();
    const app = appIdSchema.parse(`app-${crypto.randomUUID()}`);
    const other = appIdSchema.parse(`app-${crypto.randomUUID()}`);
    const claimed = hello(anthropic, {
      work: {
        authority: {
          subject: { type: "app", appId: app },
          onBehalfOf: "person-1",
          mode: "workflow",
          appVersion: 1,
        },
        context: { type: "app", appId: other },
      },
    });

    await expect(outcome(call(claimed))).resolves.toBe(
      "permission.context_invalid"
    );
    expect(fake.requests).toStrictEqual([]);
    await expect(eventsOf(claimed.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "permission.context_invalid", because: null },
      },
    ]);
  });

  it("refuse and audit a call that comes without a work context", async () => {
    const { fake, call } = await withRules();
    const { work: _, ...withoutWork } = hello(anthropic);
    // SAFETY: missing on purpose, as from a caller that isn't type-checked;
    // every typed caller must pass `work`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const contextless = withoutWork as ModelCall<undefined>;

    await expect(outcome(call(contextless))).resolves.toBe(
      "permission.context_invalid"
    );
    expect(fake.requests).toStrictEqual([]);
    await expect(eventsOf(contextless.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "permission.context_invalid", because: null },
      },
    ]);
  });
});
