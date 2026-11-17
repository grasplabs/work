import { ConnectAiProvider } from "../frame/connect-ai-provider.tsx";

// How the chat names a model and knows it has none to name: shared by its
// box, the agent's questions and the agent's settings.

/**
 * The longest question core takes (`questionSchema` in
 * apps/core/src/workspace.ts): the box stops there, so a longer one never
 * makes the round trip only to fail.
 */
export const maxQuestionLength = 100_000;

/** How a model is named in the box: the last part of its ID. */
export const modelName = (model: string): string =>
  model.split("/").at(-1) ?? model;

/**
 * Whether a question has no model it may name (`model` empty): the
 * organization has no AI provider to call yet, or none of its models is
 * chosen. Nothing is sent then.
 */
export const lacksModel = (model: string | undefined): boolean => model === "";

/**
 * Where a question names a model (`model` given) but there are none to
 * name: the way to connect an AI provider, under the agent's questions.
 */
export const NoModelNotice = ({
  model,
  models,
}: {
  model: string | undefined;
  /** Undefined while core hasn't said which yet. */
  models: readonly string[] | undefined;
}) =>
  model === undefined || models === undefined || models.length > 0 ? null : (
    <ConnectAiProvider size="xs" />
  );
