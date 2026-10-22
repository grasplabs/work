import type { ModelEffort } from "@grasp-os/shared/models";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@grasp-os/ui/components/input-group";
import {
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@grasp-os/ui/components/prompt-input";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { ModelPicker } from "./model-picker.tsx";

// Where a question is written, in the prototype's look
// (grasplabs/prototype `components/chat/chat-composer.tsx`): a box that
// grows with what is typed, the model that answers below it on the left,
// and send, or stop while Grasp answers, on the right. Enter sends;
// Shift+Enter starts a new line. The models are core's: no keys or
// providers are set here. One control picks the model and, for a model
// that thinks, how hard (grasplabs/prototype `model-picker.tsx`). It is
// laid out on the kit's prompt input parts, the prototype's AI Elements
// prompt input; the prototype's attachments, screenshot and dictation
// aren't here: core takes no files with a question, and dictation waits
// on a decision about where its audio goes.

/**
 * The longest question core takes (`questionSchema` in
 * apps/core/src/workspace.ts): the box stops there, so a longer one never
 * makes the round trip only to fail.
 */
const maxQuestionLength = 100_000;

/** Sends the question, or stops the answer while Grasp is writing it. */
const SendOrStop = ({
  running,
  busy,
  canSend,
  compact,
  onStop,
}: {
  running: boolean;
  busy: boolean;
  canSend: boolean;
  compact: boolean;
  onStop?: () => void;
}) => {
  const { t } = useLingui();
  // While Grasp answers it stops the answer; while a question is on its
  // way it waits; else it sends, grey until there is something to send.
  let status: "ready" | "submitted" | "streaming" = "ready";
  if (running) {
    status = "streaming";
  } else if (busy) {
    status = "submitted";
  }
  return (
    <PromptInputSubmit
      disabled={running ? busy : !canSend}
      // Only an answer being written can be stopped.
      onStop={running ? onStop : undefined}
      sendLabel={t({ message: "Send", context: "send the question" })}
      size={compact ? "icon-xs" : "icon-sm"}
      status={status}
      stopLabel={t({ message: "Stop", context: "stop the answer" })}
      variant={running || canSend ? "default" : "secondary"}
    />
  );
};

/** The model a question names, where there are models to pick from. */
const ModelChoice = ({
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
  addProvider,
}: {
  models: readonly string[];
  model: string | undefined;
  onModel: ((model: string) => void) | undefined;
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: ((effort: ModelEffort) => void) | undefined;
  addProvider: boolean;
}) => (
  <PromptInputTools>
    {models.length === 0 ||
    model === undefined ||
    onModel === undefined ? null : (
      <ModelPicker
        addProvider={addProvider}
        effort={effort}
        efforts={efforts}
        model={model}
        models={models}
        onEffort={onEffort}
        onModel={onModel}
      />
    )}
  </PromptInputTools>
);

/** What the question is typed in: Enter sends it, Shift+Enter starts a new line. */
const QuestionField = ({
  text,
  onText,
  compact,
  label,
  placeholder,
  maxLength,
}: {
  text: string;
  onText: (text: string) => void;
  compact: boolean;
  label: string | undefined;
  placeholder: string | undefined;
  maxLength: number | undefined;
}) => {
  const { t } = useLingui();
  const name = label ?? t`Your question`;
  const hint = placeholder ?? t`Ask anything, or describe a process`;
  const longest = maxLength ?? maxQuestionLength;
  if (compact) {
    // One line in the input group's own spacing, which the prompt box's
    // field, spaced for the box, doesn't fit.
    return (
      <InputGroupTextarea
        aria-label={name}
        className="field-sizing-content max-h-40 min-h-0"
        maxLength={longest}
        name="message"
        onChange={(event) => {
          onText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={hint}
        rows={1}
        value={text}
      />
    );
  }
  return (
    <PromptInputTextarea
      aria-label={name}
      maxLength={longest}
      onChange={(event) => {
        onText(event.target.value);
      }}
      placeholder={hint}
      value={text}
    />
  );
};

/** Where nobody picks a model. */
const noModels: readonly string[] = [];

/** Where the model doesn't think, or nobody picks how hard. */
const noLevels: readonly ModelEffort[] = [];

/** The box to ask in. Controlled: the page keeps the text and the model. */
export const Composer = ({
  text,
  onText,
  models = noModels,
  model,
  onModel,
  efforts = noLevels,
  effort,
  onEffort,
  addProvider = false,
  running,
  busy,
  failure,
  onSend,
  onStop,
  compact = false,
  label,
  placeholder,
  children,
  maxLength,
  disabled = false,
}: {
  text: string;
  onText: (text: string) => void;
  /**
   * The models a question may name, the default first, and the one it
   * names; none where nobody picks one, such as a guest's chat.
   */
  models?: readonly string[];
  model?: string;
  onModel?: (model: string) => void;
  /**
   * The efforts `model` takes, least first, and the one the question
   * names; none for a model that doesn't think, which shows the model
   * alone.
   */
  efforts?: readonly ModelEffort[];
  effort?: ModelEffort;
  onEffort?: (effort: ModelEffort) => void;
  /** Whether the picker offers to add a provider: for an admin. */
  addProvider?: boolean;
  /** Whether Grasp is answering in this chat now. */
  running: boolean;
  /** Whether a question or a stop is on its way to core. */
  busy: boolean;
  failure?: string;
  onSend: () => void;
  /** Stops the answer being written; only where one can be. */
  onStop?: () => void;
  /**
   * One line that grows as it is typed in, its button beside it and no
   * model to pick (the default model asks): the chat dock and the guest
   * page.
   */
  compact?: boolean;
  /** What the box is called; "Your question" without it. */
  label?: string;
  placeholder?: string;
  /** Beside the button, in a compact box only: such as the way to open the dock. */
  children?: ReactNode;
  /** The longest message it takes; a question's by default. */
  maxLength?: number;
  /** Takes nothing for now, while something else is on its way to core. */
  disabled?: boolean;
}) => {
  const { t } = useLingui();
  const empty = text.trim() === "";
  // A question names a model where there are any to name.
  const canSend = !running && !busy && !disabled && !empty && model !== "";
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) {
          onSend();
        }
      }}
    >
      {compact ? (
        // One line, its button beside it: the chat dock and the guest page.
        <InputGroup size="chat">
          <QuestionField
            compact={compact}
            label={label}
            maxLength={maxLength}
            onText={onText}
            placeholder={placeholder}
            text={text}
          />
          <InputGroupAddon align="inline-end" className="self-end">
            <div className="flex items-center gap-1">
              {children}
              <SendOrStop
                busy={busy}
                canSend={canSend}
                compact={compact}
                onStop={onStop}
                running={running}
              />
            </div>
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <InputGroup size="prompt">
          <PromptInputBody>
            <QuestionField
              compact={compact}
              label={label}
              maxLength={maxLength}
              onText={onText}
              placeholder={placeholder}
              text={text}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <ModelChoice
              addProvider={addProvider}
              effort={effort}
              efforts={efforts}
              model={model}
              models={models}
              onEffort={onEffort}
              onModel={onModel}
            />
            <SendOrStop
              busy={busy}
              canSend={canSend}
              compact={compact}
              onStop={onStop}
              running={running}
            />
          </PromptInputFooter>
        </InputGroup>
      )}
      {compact || model === undefined || models.length > 0 ? null : (
        <p className="text-muted-foreground px-1 text-xs">
          {t`No model is set up for this deployment yet.`}
        </p>
      )}
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};
