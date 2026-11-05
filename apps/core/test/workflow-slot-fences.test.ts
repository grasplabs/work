import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { admitAttempt } from "../src/workflows/quotas.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import {
  withShares,
  ownerOf,
  anotherRun,
  testGeneration,
  attemptOf,
  admit,
  shown,
  admitExactly,
  settled,
} from "./workflow-slots.ts";

const idp = mockIdp();

describe("a fenced workflow attempt's slot", { timeout: 120_000 }, () => {
  it("come back to the activation that took its run over, at its first admission of any step, and never to the attempts of the activation it replaced, under the same key or another", async () => {
    const builder = await signedInApi(idp, "builder");
    const owner = await ownerOf(builder);
    const other = await anotherRun(builder, owner);

    const result = await withShares(
      { workflowClientAttempts: 2, workflowAppAttempts: 1 },
      async () => {
        // The activation that dies mid-attempt holds the workflow's share.
        const dies = attemptOf("dies");
        const first = await admitExactly(owner, dies);
        // The engine took the run over: its next activation runs another
        // step, which finds the share the dead one held.
        const takeover = await admit(owner, "next", undefined, 1);
        // The dead activation's attempt, admitted again under its key,
        // and another of its steps, landing late: neither takes a share.
        const sameKey = await admitExactly(owner, dies);
        const anotherStep = await admitExactly(owner, attemptOf("late"));
        // Once the new activation's attempt settles, the share is free:
        // nothing of the dead one holds it.
        await settled(takeover);
        const otherRun = await admitExactly(other, attemptOf("other"));
        return {
          first,
          takeover: shown(takeover),
          sameKey,
          anotherStep,
          otherRun,
        };
      }
    );

    expect(result).toStrictEqual({
      first: "ok",
      takeover: "ok",
      sameKey: "execution.stale_attempt",
      anotherStep: "execution.stale_attempt",
      otherRun: "ok",
    });
  });
});

describe(
  "a fenced attempt's calls, after a takeover",
  { timeout: 120_000 },
  () => {
    it("give back once the host calls a fenced attempt reserved and didn't make, as its code returns, its time charged as it was", async () => {
      const builder = await signedInApi(idp, "builder");
      const owner = await ownerOf(builder);
      const callsMade = 5;
      const hostCalls = async (): Promise<number> =>
        (await env.DB.prepare(
          "SELECT host_calls AS calls FROM run_lineages WHERE root_run_id = ?"
        )
          .bind(owner.root)
          .first<number>("calls")) ?? 0;
      const usedOf = async (key: string): Promise<number | null> =>
        await env.DB.prepare(
          "SELECT used_ms AS used FROM run_lineage_attempts WHERE run_id = ? AND step_key = ?"
        )
          .bind(owner.run, key)
          .first<number | null>("used");

      const result = await withShares({}, async () => {
        const before = await hostCalls();
        const admission = await admitAttempt(env, owner, attemptOf("calls"));
        for (let call = 0; call < callsMade; call += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one call after another, as an attempt makes them
          await admission.hostCall();
        }
        // The engine took the run over: the new activation's first admission
        // settles the attempt, which still runs.
        const next = await admitAttempt(env, owner, {
          ...attemptOf("next"),
          generation: testGeneration + 1,
        });
        const reservedWhileFenced = (await hostCalls()) - before;
        const usedWhenFenced = await usedOf("key-calls");
        // Its code returns: what it reserved and didn't make comes back,
        // once, however often it settles.
        await admission.settle();
        await admission.settle();
        await next.settle();
        return {
          reservedMore: reservedWhileFenced > callsMade,
          charged: (await hostCalls()) - before,
          timeKept: (await usedOf("key-calls")) === usedWhenFenced,
        };
      });

      expect(result).toStrictEqual({
        reservedMore: true,
        charged: callsMade,
        timeKept: true,
      });
    });
  }
);
