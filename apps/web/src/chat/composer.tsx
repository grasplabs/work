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
} from "@grasp-os/ui/components/input-group";
import { PromptEditor } from "@grasp-os/ui/components/prompt-editor";
import type {
  PromptEditorHandle,
  PromptMention,
  PromptMentionKind,
  PromptTrigger,
} from "@grasp-os/ui/components/prompt-editor";
import {
  PromptInputSubjectBar,
  PromptInputBody,
  PromptInputButton,
  PromptInputCover,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTools,
} from "@grasp-os/ui/components/prompt-input";
import { Separator } from "@grasp-os/ui/components/separator";
import { msg, select } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChevronDownIcon } from "lucide-react";
import { useRef } from "react";
import type { ReactNode, Ref } from "react";

import { ErrorText } from "../error-text.tsx";
import {
  ConnectAiProvider,
  ConnectAiProviderCover,
} from "../frame/connect-ai-provider.tsx";
import { FileCards } from "./chat-files.tsx";
import type { CardFile } from "./chat-files.tsx";
import { ComposerMenu } from "./composer-menu.tsx";
import {
  useMentionables,
  useMentionKinds,
  useMentionTrigger,
} from "./mentions.tsx";
import { isEffort } from "./model-choice.ts";
import { ProviderMark } from "./provider-marks.tsx";

// Where a question is written: a box that grows with what is typed, and
// under it, on the left, the model that answers, by its provider's mark,
// its name and how hard it thinks; on the right, what the page adds (the
// recent chats, on Chat's own page), the add menu (composer-menu.tsx:
// files, mentions, commands and skills) and send, or stop while Grasp
// answers. Enter sends; Shift+Enter starts a new line. The models are
// core's: no keys or providers are set here. While the organization has
// no AI provider, the box is covered, blurred and out of reach, with the
// way to connect one. It is laid out on the kit's prompt input parts.
// Files are attached from the add menu, or by pasting them, and shown as
// cards over the text until the question carries them (chat-files.tsx);
// the compact box takes none. Dictation waits on a decision about where
// its audio goes.

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
      <span className="max-w-48 min-w-0 truncate">{name}</span>
      {effort === undefined ? null : (
        <span className="text-muted-foreground shrink-0">
          {t(effortNames[effort])}
        </span>
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
        // In a narrow box the name gives way, never the buttons beside it.
        render={<PromptInputButton className="min-w-0 shrink" size="sm" />}
      >
        <ProviderMark model={model} />
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

/** The model the chat's agent answers with, where an admin gave it one: said, with nothing to pick. */
const AgentModel = ({ model }: { model: string }) => {
  const { t } = useLingui();
  const name = modelName(model);
  return (
    <span
      aria-label={t`Model: ${name}, set for this agent`}
      className="text-muted-foreground flex min-w-0 items-center gap-1.5 px-2 text-sm"
    >
      <ProviderMark model={model} />
      <span aria-hidden className="max-w-48 min-w-0 truncate">
        {name}
      </span>
    </span>
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
  agent,
  agentModel,
}: {
  models: readonly string[];
  model: string | undefined;
  onModel: ((model: string) => void) | undefined;
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: ((effort: ModelEffort) => void) | undefined;
  agent: ReactNode;
  agentModel: string | undefined;
}) => (
  <PromptInputTools>
    {agent}
    {agentModel === undefined ? null : <AgentModel model={agentModel} />}
    {agentModel !== undefined ||
    models.length === 0 ||
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
  </PromptInputTools>
);

/** What the box takes typed: its text, its mentions, and what it does with keys and pastes. */
export interface FieldProps {
  text: string;
  onText: (text: string) => void;
  mentions: readonly PromptMention[] | undefined;
  onMentions: ((mentions: readonly PromptMention[]) => void) | undefined;
  onSubmit: () => void;
  label: string | undefined;
  describedBy: string | undefined;
  placeholder: string | undefined;
  maxLength: number | undefined;
  onPasteFiles: ((files: File[]) => void) | undefined;
  onBackspaceEmpty: (() => void) | undefined;
  editor: Ref<PromptEditorHandle>;
}

/** The box's field: what is typed, and what it mentions (`triggers`, `kinds`). */
const QuestionField = ({
  text,
  onText,
  mentions,
  onMentions,
  onSubmit,
  label,
  describedBy,
  placeholder,
  maxLength,
  onPasteFiles,
  onBackspaceEmpty,
  editor,
  size,
  triggers,
  kinds,
}: FieldProps & {
  size: "prompt" | "compact" | "bar";
  triggers?: readonly PromptTrigger[];
  kinds?: Readonly<Record<string, PromptMentionKind>>;
}) => {
  const { t } = useLingui();
  return (
    <PromptEditor
      describedBy={describedBy}
      kinds={kinds}
      label={label ?? t`Your question`}
      maxLength={maxLength ?? maxQuestionLength}
      onBackspaceEmpty={onBackspaceEmpty}
      mentions={mentions}
      onChange={({ text: typed, mentions: mentioned }) => {
        onText(typed);
        onMentions?.(mentioned);
      }}
      onPasteFiles={onPasteFiles}
      onSubmit={onSubmit}
      placeholder={placeholder ?? t`Ask anything, or describe a process`}
      ref={editor}
      size={size}
      triggers={triggers}
      value={text}
    />
  );
};

/**
 * The full box's field, or the chat bar's (`size`), where the person can
 * mention an App, a workflow or someone (`@`, mentions.tsx), as chips in
 * the text.
 */
export const MentioningField = ({
  size = "prompt",
  ...props
}: FieldProps & { size?: "prompt" | "bar" }) => {
  const mentionables = useMentionables();
  const kinds = useMentionKinds();
  const trigger = useMentionTrigger(mentionables);
  return (
    <QuestionField {...props} kinds={kinds} size={size} triggers={[trigger]} />
  );
};

/** Where nobody picks a model. */
export const noModels: readonly string[] = [];

/**
 * Whether a question has no model it may name (`model` empty): the
 * organization has no AI provider to call yet, or none of its models is
 * chosen. Nothing is sent then.
 */
export const lacksModel = (model: string | undefined): boolean => model === "";

/**
 * Where a question names a model (`model` given) but there are none to
 * name: the way to connect an AI provider, under the box to ask in or the
 * questions asked in its place.
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

/** Where the model doesn't think, or nobody picks how hard. */
const noLevels: readonly ModelEffort[] = [];

/** Where no file waits for the question. */
const noFiles: readonly CardFile[] = [];

/** The box to ask in. Controlled: the page keeps the text and the model. */
export const Composer = ({
  text,
  onText,
  mentions,
  onMentions,
  models: offered,
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
  describedBy,
  placeholder,
  children,
  actions,
  subject,
  maxLength,
  disabled = false,
  files = noFiles,
  onAttach,
  onRemoveFile,
  agent,
  agentModel,
}: {
  text: string;
  onText: (text: string) => void;
  /** What is typed mentions, as chips; none in a compact box. */
  mentions?: readonly PromptMention[];
  /** The mentions in what is typed, as they change. */
  onMentions?: (mentions: readonly PromptMention[]) => void;
  /**
   * The models a question may name, the default first, and the one it
   * names; none where nobody picks one, such as a guest's chat, and
   * undefined too while core hasn't said which yet.
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
  /** The id of what says more about the box, in a compact box. */
  describedBy?: string;
  placeholder?: string;
  /** Beside the button, in a compact box only: such as the way to open the dock. */
  children?: ReactNode;
  /** Before the add menu, in a full box: such as the recent chats on Chat's own page. */
  actions?: ReactNode;
  /** What the question is about, on the bar above a full box: a page's subject (`PromptInputSubjectBar`). */
  subject?: ReactNode;
  /** The longest message it takes; a question's by default. */
  maxLength?: number;
  /** Takes nothing for now, while something else is on its way to core. */
  disabled?: boolean;
  /** The files the question will carry, each shown as a card. */
  files?: readonly CardFile[];
  /** Adds files to the question; without it, the box takes none. */
  onAttach?: (files: readonly File[]) => void;
  onRemoveFile?: (id: string) => void;
  /**
   * Which agent answers, beside the model: the way to pick one for a new
   * chat, or the name of the one an open chat is with (agent-choice.tsx).
   * Not in a compact box.
   */
  agent?: ReactNode;
  /**
   * The model the chat's agent answers with, where an admin gave it one:
   * shown in place of the picker, as core asks it whichever is picked.
   */
  agentModel?: string;
}) => {
  const empty = text.trim() === "";
  const models = offered ?? noModels;
  // No AI provider to call yet: the box is covered, and takes nothing. Not
  // while the models are still being read, so what is typed then stays.
  const noProvider = offered !== undefined && lacksModel(model);
  const form = useRef<HTMLFormElement>(null);
  const editor = useRef<PromptEditorHandle>(null);
  // A question names a model where there are any to name.
  const canSend =
    !running && !busy && !disabled && !empty && !lacksModel(model);
  // Pasting files adds them, and Backspace in an empty box takes the last off.
  const last = files.at(-1);
  const field: FieldProps = {
    text,
    onText,
    mentions,
    onMentions,
    onSubmit: () => {
      form.current?.requestSubmit();
    },
    label,
    describedBy,
    placeholder,
    maxLength,
    onPasteFiles: onAttach,
    onBackspaceEmpty:
      onRemoveFile === undefined || last === undefined
        ? undefined
        : () => {
            onRemoveFile(last.id);
          },
    editor,
  };
  return (
    <form
      className="flex flex-col gap-1.5"
      ref={form}
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
          <QuestionField {...field} size="compact" />
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
        // The bar and the box as one: the box's top over the bar's bottom.
        <div className="flex flex-col">
          {subject === undefined ? null : (
            <PromptInputSubjectBar>{subject}</PromptInputSubjectBar>
          )}
          <InputGroup size="prompt">
            {files.length === 0 ? null : (
              <PromptInputHeader>
                {/* Not removable while the question is on its way with them. */}
                <FileCards
                  files={files}
                  onRemove={busy ? undefined : onRemoveFile}
                />
              </PromptInputHeader>
            )}
            <PromptInputBody inert={noProvider}>
              <MentioningField {...field} describedBy={undefined} />
            </PromptInputBody>
            <PromptInputFooter inert={noProvider}>
              <ModelChoice
                agent={agent}
                agentModel={agentModel}
                effort={effort}
                efforts={efforts}
                model={model}
                models={models}
                onEffort={onEffort}
                onModel={onModel}
              />
              <div className="flex items-center gap-1">
                {actions === undefined ? null : (
                  <>
                    {actions}
                    {/* As tall as the icons, centred on them. */}
                    <div className="mx-1 flex h-4">
                      <Separator orientation="vertical" />
                    </div>
                  </>
                )}
                <ComposerMenu
                  disabled={busy || disabled}
                  onAttach={onAttach}
                  onMention={(mentioned, trigger) => {
                    editor.current?.insertMention(mentioned, trigger);
                  }}
                />
                <SendOrStop
                  busy={busy}
                  canSend={canSend}
                  compact={compact}
                  onStop={onStop}
                  running={running}
                />
              </div>
            </PromptInputFooter>
            {noProvider ? (
              <PromptInputCover>
                <ConnectAiProviderCover />
              </PromptInputCover>
            ) : null}
          </InputGroup>
        </div>
      )}
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};
