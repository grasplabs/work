/**
 * How a client's Brain is doing, as its core reports it (core's
 * src/brain-report.ts, `@grasp-os/shared/brain-report`), and what staff
 * may do to it and whether something was erased from it: read live and
 * signed for as the AI status is
 * (src/clients/core-report.ts), naming the staff member Access let in,
 * whom core's audit log records for every read and every action. Nothing
 * of it is kept here: the page reads it as it opens and after an action.
 */
import {
  brainActionAnswerSchema,
  brainActionPath,
  brainActionPurpose,
  brainActionSchema,
  brainErasureAnswerSchema,
  brainErasureLookupSchema,
  brainErasurePath,
  brainErasurePurpose,
  brainReportPath,
  brainReportPurpose,
  brainReportSchema,
} from "@grasp-os/shared/brain-report";
import type {
  BrainActionOutcome,
  BrainErasureAnswer,
  BrainReport,
} from "@grasp-os/shared/brain-report";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { askClientCore, signedCoreReport } from "./core-report.ts";

/** What staff ask of one client's Brain. */
export const brainActionInputSchema = z.object({
  clientId: z.string().min(1).max(63),
  action: brainActionSchema,
});

/**
 * What an action did, or that its core didn't answer
 * (`not_answered`): the page reads the report again either way.
 */
export interface BrainActionResult {
  outcome: BrainActionOutcome | "not_answered";
}

/** Client `clientId`'s Brain, as its core reports it to `staff` now; null when it doesn't answer. */
export const readBrainReport = async (
  env: Env,
  staff: Pick<Staff, "email">,
  clientId: string
): Promise<BrainReport | null> =>
  await askClientCore(
    env,
    clientId,
    "brain_report",
    async (request) =>
      await signedCoreReport(request, {
        path: brainReportPath,
        purpose: brainReportPurpose,
        schema: brainReportSchema,
        fields: { staff: { email: staff.email } },
      })
  );

/** What `staff` asked of a client's Brain, as its core did it. */
export const actOnBrain = async (
  env: Env,
  staff: Pick<Staff, "email">,
  input: z.input<typeof brainActionInputSchema>
): Promise<BrainActionResult> => {
  const { clientId, action } = brainActionInputSchema.parse(input);
  const answer = await askClientCore(
    env,
    clientId,
    "brain_action",
    async (request) =>
      await signedCoreReport(request, {
        path: brainActionPath,
        purpose: brainActionPurpose,
        schema: brainActionAnswerSchema,
        fields: { staff: { email: staff.email }, action },
      })
  );
  return { outcome: answer?.outcome ?? "not_answered" };
};

/** What staff look up in one client's Brain: a source's key or a person's id. */
export const brainErasureInputSchema = z.object({
  clientId: z.string().min(1).max(63),
  lookup: brainErasureLookupSchema,
});

/** Whether it was erased, or that its core didn't answer (`not_answered`). */
export type BrainErasureResult = BrainErasureAnswer | { state: "not_answered" };

/**
 * Whether what `staff` named was erased from a client's Brain, as its
 * core answers: core records the lookup in the client's audit log first.
 * Nothing of it is kept here.
 */
export const lookUpBrainErasure = async (
  env: Env,
  staff: Pick<Staff, "email">,
  input: z.input<typeof brainErasureInputSchema>
): Promise<BrainErasureResult> => {
  const { clientId, lookup } = brainErasureInputSchema.parse(input);
  const answer = await askClientCore(
    env,
    clientId,
    "brain_erasure",
    async (request) =>
      await signedCoreReport(request, {
        path: brainErasurePath,
        purpose: brainErasurePurpose,
        schema: brainErasureAnswerSchema,
        fields: { staff: { email: staff.email }, lookup },
      })
  );
  return answer ?? { state: "not_answered" };
};
