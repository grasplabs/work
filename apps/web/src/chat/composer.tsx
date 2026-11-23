import type { ModelEffort } from "@grasp-os/shared/models";
import { Button } from "@grasp-os/ui/components/button";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEffort,
  ModelSelectorEmpty,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@grasp-os/ui/components/model-selector";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBanner,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputMention,
  PromptInputNote,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@grasp-os/ui/components/prompt-input";
import { Text } from "@grasp-os/ui/components/text";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { msg, select } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
import type { ReactNode } from "react";

import { useMemberAdmin } from "../use-member-admin.ts";
import { acceptedFiles, FileCards } from "./chat-files.tsx";
import type { CardFile } from "./chat-files.tsx";
import { promptStatusOf } from "./chat-states.ts";
import { ConnectAiProvider } from "./connect-ai-provider.tsx";
import {
  mentionsOf,
  textOf,
  useMentionables,
  useMentionTriggers,
} from "./mentions.tsx";
import type { BoxMention, BoxValue } from "./mentions.tsx";
import { isEffort } from "./model-choice.ts";

// Where a question is written, on Damsko's PromptInput: a card that grows
// with what is typed; at its foot, the add menu (files or photos, also
// pasted or dropped), the model that answers and how hard it thinks in one
// Model selector, what the page adds, and Send, which is Stop while Grasp
// answers (its status from the chat: chat-states.ts). `@` mentions the
// agents, Apps, workflows and people (mentions.tsx). The text is the
// page's (use-ask.ts): the box follows it, and tells it each change. Files
// are the page's too: whatever is picked, pasted or dropped is handed to
// it, which checks them and shows each as a card over the text until the
// question carries them. While the organization has no AI provider, the
// box takes nothing and its banner says how to connect one. A model is
// named, never marked: the product draws a maker's mark only for an exact
// id it has one for (connections/brands.ts), and has none for an AI
// provider.

const styles = stylex.create({
  agentModel: { display: "inline-flex", alignItems: "center", minWidth: 0 },
  // The files take the header's whole line, over the subject's: their row
  // takes no width from its files, and would shrink to nothing beside it.
  files: {
    position: "relative",
    zIndex: 1,
    flexBasis: "100%",
    flexShrink: 0,
    minWidth: 0,
  },
});

/**
 * The longest question core takes (`questionSchema` in
 * apps/core/src/workspace.ts): the box stops there, so a longer one never
 * makes the round trip only to fail.
 */
const maxQuestionLength = 100_000;

/** How a model is named in the box: the last part of its ID. */
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

/** Which model answers the next question, and how hard it thinks first, as one Model selector. */
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
  const level =
    thinks && effort !== undefined ? t(effortNames[effort]) : undefined;
  return (
    <ModelSelector
      onValueChange={onModel}
      value={model}
      {...(thinks
        ? {
            effort: effort ?? "",
            onEffortChange: (next: string) => {
              if (isEffort(next) && efforts.includes(next)) {
                onEffort(next);
              }
            },
          }
        : {})}
    >
      <ModelSelectorTrigger
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
      >
        <ModelSelectorName>
          {level === undefined ? name : `${name} · ${level}`}
        </ModelSelectorName>
      </ModelSelectorTrigger>
      <ModelSelectorContent side="top">
        <ModelSelectorInput />
        <ModelSelectorList>
          <ModelSelectorEmpty />
          {models.map((each, index) => (
            <ModelSelectorItem
              {...(index === 0 ? { description: t`The default` } : {})}
              key={each}
              value={each}
            >
              <ModelSelectorName>{modelName(each)}</ModelSelectorName>
            </ModelSelectorItem>
          ))}
        </ModelSelectorList>
        {thinks ? (
          <ModelSelectorEffort
            heading={t`How hard it thinks`}
            levels={efforts.map((each) => ({
              value: each,
              label: t(effortNames[each]),
            }))}
          />
        ) : null}
      </ModelSelectorContent>
    </ModelSelector>
  );
};

/** The model the chat's agent answers with, where an admin gave it one: said, with nothing to pick. */
const AgentModel = ({ model }: { model: string }) => {
  const { t } = useLingui();
  const name = modelName(model);
  return (
    <span {...stylex.props(styles.agentModel)}>
      <span {...stylex.props(visuallyHidden)}>
        {t`Model: ${name}, set for this agent`}
      </span>
      <span aria-hidden="true">
        <Text as="span" color="muted" size="sm" truncate>
          {name}
        </Text>
      </span>
    </span>
  );
};

/** The box's tools at its foot: add, the agent and the model in a full box; what the page adds. */
const ComposerTools = ({
  compact,
  attaches,
  agent,
  agentModel,
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
  actions,
  children,
}: {
  compact: boolean;
  /** The box takes files. */
  attaches: boolean;
  agent: ReactNode;
  agentModel: string | undefined;
  models: readonly string[];
  model: string | undefined;
  onModel: ((model: string) => void) | undefined;
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: ((effort: ModelEffort) => void) | undefined;
  actions: ReactNode;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  if (compact) {
    return <PromptInputTools>{children}</PromptInputTools>;
  }
  return (
    <PromptInputTools>
      {attaches ? (
        <PromptInputActionMenu>
          <PromptInputActionMenuTrigger aria-label={t`Add`} />
          <PromptInputActionMenuContent>
            <PromptInputActionAddAttachments>
              {t`Add files or photos`}
            </PromptInputActionAddAttachments>
          </PromptInputActionMenuContent>
        </PromptInputActionMenu>
      ) : null}
      {agent}
      {agentModel === undefined ? null : <AgentModel model={agentModel} />}
      {agentModel === undefined &&
      models.length > 0 &&
      model !== undefined &&
      onModel !== undefined ? (
        <ModelPicker
          effort={effort}
          efforts={efforts}
          model={model}
          models={models}
          onEffort={onEffort}
          onModel={onModel}
        />
      ) : null}
      {actions}
    </PromptInputTools>
  );
};

/** The files the question will carry, over the text: not removable while it is on its way. */
const BoxFiles = ({
  files,
  busy,
  onRemove,
}: {
  files: readonly CardFile[];
  busy: boolean;
  onRemove: ((id: string) => void) | undefined;
}) =>
  files.length === 0 ? null : (
    <div {...stylex.props(styles.files)}>
      <FileCards files={files} onRemove={busy ? undefined : onRemove} />
    </div>
  );

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
 * name: the way to connect an AI provider, under the questions asked in
 * the box's place.
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
    <ConnectAiProvider />
  );

/** No AI provider to call yet: the box's banner, with the way to connect one for whoever can. */
const NoProviderBanner = () => {
  const canConnect = useMemberAdmin();
  return (
    <PromptInputBanner
      action={
        canConnect ? (
          <Button asChild size="sm" variant="outline">
            <Link to="/settings/ai-providers">
              <Trans>Go to AI providers</Trans>
            </Link>
          </Button>
        ) : undefined
      }
      variant="warning"
    >
      {canConnect ? (
        <Trans>Connect an AI provider to start asking</Trans>
      ) : (
        <Trans>
          Connect an AI provider to start asking. Ask your admin to connect one.
        </Trans>
      )}
    </PromptInputBanner>
  );
};

/**
 * Hands every file picked, pasted or dropped on the box to the page, which
 * keeps them: the box's own list stays empty.
 */
const FilesToPage = ({
  onAttach,
}: {
  onAttach: ((files: readonly File[]) => void) | undefined;
}) => {
  const { files, clear } = usePromptInputAttachments();
  useEffect(() => {
    if (files.length > 0) {
      onAttach?.(files.map(({ file }) => file));
      clear();
    }
  }, [files, onAttach, clear]);
  return null;
};

/** What `@` offers in a box that mentions: read from core only there. */
const BoxMentions = () => {
  const triggers = useMentionTriggers(useMentionables());
  return <PromptInputMention triggers={triggers} />;
};

/** Where the model doesn't think, or nobody picks how hard. */
const noLevels: readonly ModelEffort[] = [];

/** Where nothing is mentioned. */
const noMentions: readonly BoxMention[] = [];

/** Where no file waits for the question. */
const noFiles: readonly CardFile[] = [];

/**
 * The box's value for words the page set: plain words, each of the page's
 * mentions a token where its `@` and name stand.
 */
const valueFor = (text: string, mentions: readonly BoxMention[]): BoxValue => {
  const value: BoxValue = [];
  let rest = text;
  for (const mention of mentions) {
    const written = `${mention.trigger}${mention.label}`;
    const at = rest.indexOf(written);
    if (at !== -1) {
      value.push(rest.slice(0, at), {
        type: "mention",
        value: `${mention.kind}:${mention.id}`,
        label: mention.label,
      });
      rest = rest.slice(at + written.length);
    }
  }
  value.push(rest);
  return value.filter((segment) => segment !== "");
};

/**
 * Sending from the box: at once where it can; asked before core has said
 * which models there are (`offered` undefined, no `model` yet), held, the
 * box saying it goes, and sent once core has, with no second press. Never
 * while Grasp answers or a question is on its way, nor with nothing typed.
 */
const useSend = ({
  text,
  running,
  busy,
  offered,
  model,
  onSend,
}: {
  text: string;
  running: boolean;
  busy: boolean;
  offered: readonly string[] | undefined;
  model: string | undefined;
  onSend: () => void;
}): { held: boolean; submit: () => void } => {
  const asked = !running && text.trim() !== "";
  const canSend = asked && !busy && !lacksModel(model);
  const loadingModels = offered === undefined && lacksModel(model);
  const [held, setHeld] = useState(false);
  // How many held questions were let go: each sends once, after the render.
  const [released, setReleased] = useState(0);
  if (held && !loadingModels) {
    setHeld(false);
    setReleased(released + 1);
  }
  const sendReleased = useEffectEvent(() => {
    if (canSend) {
      onSend();
    }
  });
  useEffect(() => {
    if (released > 0) {
      sendReleased();
    }
  }, [released]);
  return {
    held,
    submit: () => {
      if (canSend) {
        onSend();
      } else if (loadingModels && asked) {
        setHeld(true);
      }
    },
  };
};

/** The box to ask in. Controlled: the page keeps the text and the model. */
export const Composer = ({
  text,
  onText,
  mentions = noMentions,
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
  placeholder,
  children,
  actions,
  subject,
  files = noFiles,
  onAttach,
  onRemoveFile,
  agent,
  agentModel,
}: {
  text: string;
  onText: (text: string) => void;
  /** The mentions the page holds: where it sets words, they stand as tokens. */
  mentions?: readonly BoxMention[];
  /** The mentions in what is typed, as they change. */
  onMentions?: (mentions: readonly BoxMention[]) => void;
  /**
   * The models a question may name, the default first, and the one it
   * names; none where nobody picks one, and undefined too while core
   * hasn't said which yet.
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
  /** Why the last question didn't go, under the box; its words are kept. */
  failure?: string;
  onSend: () => void;
  /** Stops the answer being written; only where one can be. */
  onStop?: () => void;
  /** One row, its tools, the text and Send side by side, no model to pick: the chat dock. */
  compact?: boolean;
  /** What the box is called; "Your question" without it. */
  label?: string;
  placeholder?: string;
  /** Among the tools, in a compact box only: such as the way to open the dock. */
  children?: ReactNode;
  /** Among the tools, in a full box: such as the recent chats on Chat's own page. */
  actions?: ReactNode;
  /** What the question is about, over the text: a page's subject. */
  subject?: ReactNode;
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
  const { t } = useLingui();
  const mentioning = onMentions !== undefined;
  const [value, setValue] = useState<BoxValue>(() => valueFor(text, mentions));
  // The page set other words (cleared once sent, a question picked under
  // the box, an agent named): the box follows.
  if (textOf(value) !== text) {
    setValue(valueFor(text, mentions));
  }
  const models = offered ?? noModels;
  // No AI provider to call yet: the box takes nothing. Not while the models
  // are still being read, so what is typed then stays.
  const noProvider = offered !== undefined && lacksModel(model);
  const { held, submit } = useSend({
    text,
    running,
    busy,
    offered,
    model,
    onSend,
  });

  return (
    <PromptInput
      accept={acceptedFiles}
      compact={compact}
      disabled={noProvider}
      maxLength={maxQuestionLength}
      onSubmit={submit}
      onValueChange={(next) => {
        setValue(next);
        onText(textOf(next));
        onMentions?.(mentionsOf(next));
      }}
      status={promptStatusOf({
        running,
        busy: busy || held,
        failed: failure !== undefined,
      })}
      value={value}
    >
      {noProvider ? <NoProviderBanner /> : null}
      {failure === undefined ? null : (
        <PromptInputNote>{failure}</PromptInputNote>
      )}
      {subject === undefined && files.length === 0 ? null : (
        <PromptInputHeader>
          {subject}
          <BoxFiles busy={busy} files={files} onRemove={onRemoveFile} />
        </PromptInputHeader>
      )}
      <PromptInputBody>
        <PromptInputTextarea
          aria-label={label ?? t`Your question`}
          {...(placeholder === undefined ? {} : { placeholder })}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <ComposerTools
          actions={actions}
          agent={agent}
          agentModel={agentModel}
          attaches={onAttach !== undefined}
          compact={compact}
          effort={effort}
          efforts={efforts}
          model={model}
          models={models}
          onEffort={onEffort}
          onModel={onModel}
        >
          {children}
        </ComposerTools>
        <PromptInputSubmit {...(onStop === undefined ? {} : { onStop })} />
      </PromptInputFooter>
      {mentioning ? <BoxMentions /> : null}
      {/* Without a way to attach, what is dropped or pasted goes nowhere. */}
      <FilesToPage onAttach={onAttach} />
    </PromptInput>
  );
};
