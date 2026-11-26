import type { ModelErrorCode } from "@grasp-os/shared/models";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// Why an answer failed, in people's words (grasplabs/prototype
// `components/chat/chat-thread.tsx`): core sends the model gateway's error
// code, never its message or a provider's, and each code has a sentence
// here. A code this page doesn't know says Grasp could not be reached.

const failureWords: Readonly<Record<ModelErrorCode, MessageDescriptor>> = {
  "model.invalid_call": msg`Grasp couldn't put this question to the model. Try again.`,
  "model.unconfigured": msg`Models aren't set up yet. Ask your admin to connect an AI provider in Settings › AI providers.`,
  "model.no_provider": msg`No AI provider is connected yet. Ask your admin to connect one.`,
  "model.provider_key_failed": msg`Your AI provider is refusing your key. Ask your admin to check or replace it in Settings › AI providers.`,
  "model.provider_unavailable": msg`Your AI provider isn't answering. This is usually an outage on their side; try again in a while.`,
  "model.not_allowed": msg`Your organization doesn't allow this model. Pick another one.`,
  "model.rate_limited": msg`Your AI provider is limiting requests (a rate or spending limit at the provider). Try again in a while.`,
  "model.answer_too_long": msg`This model can't give an answer that long. Pick another model, or ask for less.`,
  "model.grasp_limit_reached": msg`This month's limit for Grasp's AI is reached. Your admin can switch to your organization's own key in Settings › AI providers, or Grasp's AI is back next month.`,
  "model.failed": msg`The model couldn't answer. Try again.`,
  "model.request_refused": msg`The model couldn't answer. Try again.`,
  "model.invalid_output": msg`The model's answer came back in the wrong shape. Try again.`,
  "model.timeout": msg`Your AI provider sent nothing for too long, so Grasp gave up on this answer. Try again.`,
  "model.declined": msg`The model declined to answer this.`,
  "model.context_too_long": msg`This chat is too long for the model, even after Grasp summarized its earlier messages. Start a new chat to go on.`,
};

const unreachable = msg`Grasp could not be reached. Try again.`;

/**
 * The failures asking the same again can't mend: the model declined, or
 * the chat is past its window even summarized. Their answers offer no Try
 * again, and their words say what helps instead.
 */
const unmendable: ReadonlySet<unknown> = new Set<ModelErrorCode>([
  "model.declined",
  "model.context_too_long",
]);

/** Whether `failure` is a code this page has words for. */
const isKnown = (failure: unknown): failure is ModelErrorCode =>
  typeof failure === "string" && Object.hasOwn(failureWords, failure);

/** Why an answer failed, in people's words, from core's code for it. */
export const failureMessage = (failure: unknown, i18n: I18n): string =>
  i18n._(isKnown(failure) ? failureWords[failure] : unreachable);

/** Whether asking the same again may mend an answer that failed with `failure`. */
export const retryMends = (failure: unknown): boolean =>
  !unmendable.has(failure);
