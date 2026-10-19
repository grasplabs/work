import type { DecisionAnswerInput } from "@grasp-os/shared/decisions";
import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

// The one-use confirmation a person gives in the trusted host decision UI
// before their answer to a decision is recorded (spec 10.7.2, threat model
// on GRA-624). The UI shows the decision's review context and the answer
// as core will record it; the person's click there mints a confirmation
// bound to them, the decision, that context and that answer. Only the
// host page reaches the mint (the `decisions` namespace): an App's screen
// asks the page to answer, and never holds a confirmation.
//
// What is bound is fingerprinted, never kept: the context as the
// SHA-256 of its pinned fields, the answer as that of its normalized
// form. The token itself is kept only as its SHA-256, so the table holds
// nothing that answers anything.

/** How long a confirmation stays usable: its answer follows the click. */
export const confirmationTtlMs = 5 * 60_000;

/** The pinned fields of a decision a person reviews before answering. */
export interface ReviewContext {
  decision: string;
  run: string;
  app: string;
  workflow: string;
  version: number;
  step: string;
  deciders: string;
  description: string;
  expiresAt: Date;
}

/**
 * The fingerprint of a decision's review context: what an answer was
 * confirmed against, and `DecisionView.revision`. Any change to what is
 * asked, by which run, of whom or until when changes it.
 */
export const contextFingerprint = async (
  context: ReviewContext
): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      decision: context.decision,
      run: context.run,
      app: context.app,
      workflow: context.workflow,
      version: context.version,
      step: context.step,
      deciders: context.deciders,
      description: context.description,
      expiresAt: context.expiresAt.getTime(),
    })
  );

/**
 * An answer as core records it: the payload with its keys in order, and
 * none rather than `null` (the run gets `null` for either).
 */
export const normalizedAnswer = ({
  approved,
  payload,
}: DecisionAnswerInput): DecisionAnswerInput => {
  if (payload === undefined || payload === null) {
    return { approved };
  }
  // SAFETY: canonical JSON text parses back to JSON.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return { approved, payload: JSON.parse(canonicalJson(payload)) as Json };
};

/** The fingerprint of an answer, normalized: what a confirmation binds. */
export const responseFingerprint = async (
  answer: DecisionAnswerInput
): Promise<string> => {
  const { approved, payload } = normalizedAnswer(answer);
  return await sha256Hex(canonicalJson({ approved, payload: payload ?? null }));
};

/** A new confirmation token, and the hash it is kept as. */
export const newConfirmationToken = async (): Promise<{
  token: string;
  hash: string;
}> => {
  const token = randomToken();
  return { token, hash: await sha256Hex(token) };
};

/** The longest token taken; anything longer matches nothing. */
const maxTokenLength = 128;

/** The hash a confirmation token is kept as; none for what isn't one. */
export const confirmationHash = async (
  token: unknown
): Promise<string | undefined> =>
  typeof token === "string" &&
  token.length > 0 &&
  token.length <= maxTokenLength
    ? await sha256Hex(token)
    : undefined;
