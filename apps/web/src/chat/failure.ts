import type { ModelErrorCode } from "@grasp-os/shared/models";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// Why an answer failed, in people's words (grasplabs/prototype
// `components/chat/chat-thread.tsx`): core sends the model gateway's error
// code, never its message or a provider's, and each code has a sentence
// here. A code this page doesn't know says Grasp could not be reached.

const failureWords: Readonly<Record<ModelErrorCode, MessageDescriptor>> = {
  "model.invalid_call": msg`Grasp couldn't put this question to the model. Try again.`,
  "model.unconfigured": msg`Models aren't set up yet. Ask your admin to have Grasp set them up.`,
  "model.no_provider": msg`No AI provider is connected yet. Ask your admin to connect one.`,
  "model.not_allowed": msg`Your organization doesn't allow this model. Pick another one.`,
  "model.eu_only": msg`This chat stays in the EU, and this model isn't hosted there. Pick another one.`,
  "model.sensitive_data": msg`This chat holds sensitive data this model may not see. Pick another one.`,
  "model.over_budget": msg`The model budget is used up. Ask your admin to have Grasp raise it.`,
  "model.run_limit": msg`This run has made all the model calls it may make.`,
  "model.budget_busy": msg`Other questions are using what's left of the model budget. Try again in a minute.`,
  "model.queued": msg`Grasp is busy with other questions. Try again in a minute.`,
  "model.rate_limited": msg`The model is busy. Try again in a minute.`,
  "model.unpriced": msg`Grasp can't tell what this model would cost. Pick another one.`,
  "model.answer_too_long": msg`This model can't give an answer that long. Pick another model, or ask for less.`,
  "model.ledger_unavailable": msg`Grasp can't count model spend right now. Try again later.`,
  "model.quota_policy_unavailable": msg`Grasp can't read your organization's model limits right now. Try again later.`,
  "model.quota_policy_behind": msg`Your organization's model limits need a check. Ask your admin to have Grasp look at them.`,
  "model.failed": msg`The model couldn't answer. Try again.`,
  "model.invalid_output": msg`The model's answer came back in the wrong shape. Try again.`,
};

const unreachable = msg`Grasp could not be reached. Try again.`;

/** Whether `failure` is a code this page has words for. */
const isKnown = (failure: unknown): failure is ModelErrorCode =>
  typeof failure === "string" && Object.hasOwn(failureWords, failure);

/** Why an answer failed, in people's words, from core's code for it. */
export const failureMessage = (failure: unknown, i18n: I18n): string =>
  i18n._(isKnown(failure) ? failureWords[failure] : unreachable);
