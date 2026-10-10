import type { ModelEffort } from "@grasp-os/shared/models";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@grasp-os/ui/components/input-group";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { msg, select } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { isEffort } from "./model-choice.ts";

// Where a question is written, in the prototype's look
// (grasplabs/prototype `components/chat/chat-composer.tsx`): a box that
// grows with what is typed, the model that answers below it on the left,
// and send, or stop while Grasp answers, on the right. Enter sends;
// Shift+Enter starts a new line. The models are core's: no keys or
// providers are set here. One control picks the model and, for a model
// that thinks, how hard (grasplabs/prototype `model-picker.tsx`).

/** How a model is named in the box: the last part of its ID. */

/**
 * The longest question core takes (`questionSchema` in
 * apps/core/src/workspace.ts): the box stops there, so a longer one never
 * makes the round trip only to fail.
 */
const maxQuestionLength = 100_000;

export const modelName = (model: string): string =>
  model.split("/").at(-1) ?? model;

/** How each effort is called, least first. */
const effortNames = {
  low: msg({ message: "Low", context: "thinking effort" }),
  medium: msg({ message: "Medium", context: "thinking effort" }),
  high: msg({ message: "High", context: "thinking effort" }),
  xhigh: msg({ message: "Extra high", context: "thinking effort" }),
  max: msg({ message: "Max", context: "thinking effort" }),
} as const;

/** How hard the model thinks, for a model that takes an effort. */
const EffortChoice = ({
  efforts,
  effort,
  onEffort,
}: {
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: (effort: ModelEffort) => void;
}) => {
  const { t } = useLingui();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{t`How hard it thinks`}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        onValueChange={(value: unknown) => {
          if (isEffort(value) && efforts.includes(value)) {
            onEffort(value);
          }
        }}
        value={effort ?? ""}
      >
        {efforts.map((each) => (
          <DropdownMenuRadioItem key={each} value={each}>
            {t(effortNames[each])}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
};

/** What the control reads: the model, and how hard it thinks where it does. */
const ChoiceLabel = ({
  name,
  effort,
}: {
  name: string;
  effort: ModelEffort | undefined;
}) => {
  const { t } = useLingui();
  return (
    <>
      <span className="max-w-48 truncate">{name}</span>
      {effort === undefined ? null : (
        <span className="text-muted-foreground">{t(effortNames[effort])}</span>
      )}
    </>
  );
};

/** Which model answers the next question, and how hard it thinks first. */
const ModelPicker = ({
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
}: {
  models: readonly string[];
  model: string;
  onModel: (model: string) => void;
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: ((effort: ModelEffort) => void) | undefined;
}) => {
  const { t } = useLingui();
  const name = modelName(model);
  const thinks = efforts.length > 0 && onEffort !== undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={
          thinks && effort !== undefined
            ? t`Model: ${name}, thinking ${select(effort, {
                low: "low",
                medium: "medium",
                high: "high",
                xhigh: "extra high",
                other: "max",
              })}. Change model or thinking`
            : t`Model: ${name}. Change model`
        }
        render={<InputGroupButton size="sm" variant="ghost" />}
      >
        <SparklesIcon className="text-status-attention" />
        <ChoiceLabel effort={thinks ? effort : undefined} name={name} />
        <ChevronDownIcon className="text-muted-foreground size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t`Models for your organization`}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value: unknown) => {
              if (typeof value === "string") {
                onModel(value);
              }
            }}
            value={model}
          >
            {models.map((each, index) => (
              <DropdownMenuRadioItem key={each} value={each}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{modelName(each)}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {index === 0 ? t`The default, ${each}` : each}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {thinks ? (
          <>
            <DropdownMenuSeparator />
            <EffortChoice
              effort={effort}
              efforts={efforts}
              onEffort={onEffort}
            />
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

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
  return running ? (
    <InputGroupButton
      aria-label={t({ message: "Stop", context: "stop the answer" })}
      disabled={busy}
      onClick={onStop}
      size={compact ? "icon-xs" : "icon-sm"}
      type="button"
      variant="default"
    >
      <SquareIcon />
    </InputGroupButton>
  ) : (
    <InputGroupButton
      aria-label={t({
        message: "Send",
        context: "send the question",
      })}
      disabled={!canSend}
      size={compact ? "icon-xs" : "icon-sm"}
      type="submit"
      variant={canSend ? "default" : "secondary"}
    >
      {busy ? <Spinner /> : <ArrowUpIcon />}
    </InputGroupButton>
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
}: {
  models: readonly string[];
  model: string | undefined;
  onModel: ((model: string) => void) | undefined;
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: ((effort: ModelEffort) => void) | undefined;
}) => (
  <div className="flex min-w-0 items-center gap-1">
    {models.length === 0 ||
    model === undefined ||
    onModel === undefined ? null : (
      <ModelPicker
        effort={effort}
        efforts={efforts}
        model={model}
        models={models}
        onEffort={onEffort}
        onModel={onModel}
      />
    )}
  </div>
);

/** How the box looks: a prompt box under the thread, or one line (compact). */
const looks = {
  prompt: {
    size: "prompt",
    align: "block-end",
    row: "flex w-full items-center justify-between gap-1",
  },
  compact: {
    size: "default",
    align: "inline-end",
    row: "flex items-center gap-1",
  },
} as const;

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
  return (
    <InputGroupTextarea
      aria-label={label ?? t`Your question`}
      className={
        compact
          ? "field-sizing-content max-h-40 min-h-0"
          : "field-sizing-content max-h-48 min-h-16"
      }
      maxLength={maxLength ?? maxQuestionLength}
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
      placeholder={placeholder ?? t`Ask anything, or describe a process`}
      rows={compact ? 1 : undefined}
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
  const look = looks[compact ? "compact" : "prompt"];
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
      <InputGroup size={look.size}>
        <QuestionField
          compact={compact}
          label={label}
          maxLength={maxLength}
          onText={onText}
          placeholder={placeholder}
          text={text}
        />
        <InputGroupAddon
          align={look.align}
          className={compact ? "self-end" : undefined}
        >
          <div className={look.row}>
            {compact ? (
              children
            ) : (
              <ModelChoice
                effort={effort}
                efforts={efforts}
                model={model}
                models={models}
                onEffort={onEffort}
                onModel={onModel}
              />
            )}
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
      {compact || model === undefined || models.length > 0 ? null : (
        <p className="text-muted-foreground px-1 text-xs">
          {t`No model is set up for this deployment yet.`}
        </p>
      )}
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};
