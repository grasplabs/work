import { aiProviderIdSchema, aiProviders } from "@grasp-os/shared/ai-providers";
import type { ModelEffort } from "@grasp-os/shared/models";
import { Button } from "@grasp-os/ui/components/button";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEffort,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorMaker,
  ModelSelectorMakers,
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
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@grasp-os/ui/components/prompt-input";
import type { PromptInputSpeechButtonProps } from "@grasp-os/ui/components/prompt-input";
import { Text } from "@grasp-os/ui/components/text";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { msg, select } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
import type { ReactNode } from "react";

import { makerMark } from "../frame/brands.ts";
import { useNarrow } from "../onboarding/use-narrow.ts";
import { useMemberAdmin } from "../use-member-admin.ts";
import { FileCards } from "./chat-files.tsx";
import type { CardFile } from "./chat-files.tsx";
import { promptStatusOf } from "./chat-states.ts";
import { ConnectAiProvider } from "./connect-ai-provider.tsx";
import { useDictation } from "./dictation.ts";
import type { StopNote } from "./dictation.ts";
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
// Model selector; by Send, the microphone (dictation.ts); then Send, which
// is Stop while Grasp answers (its status from the chat: chat-states.ts),
// and what the page adds. In one row (the chat's idle bar) the text stands
// between the add menu and the rest, the model only once something is
// typed, so the placeholder keeps its room, as on #2503. `@` mentions the
// agents, Apps, workflows and people (mentions.tsx). The text is the
// page's (use-ask.ts): the box follows it, and tells it each change. Files
// are the page's too: whatever is picked, pasted or dropped is handed to
// it, which checks each (a kind it doesn't take is said under the box)
// and shows each as a card over the text until the question carries them.
// While the organization has no AI provider, the box takes nothing and its
// banner says how to connect one. A maker's mark is the product's own only
// for an AI provider whose id is exactly one it has a mark for
// (frame/brands.ts), else Damsko's first letter.

const styles = stylex.create({
  agentModel: { display: "inline-flex", alignItems: "center", minWidth: 0 },
  // The microphone, Send and what the page adds, at the row's end: in the
  // footer pushed to its end, in one row the card's own end column.
  end: {
    flexShrink: 0,
    marginInlineStart: "auto",
    gridArea: "end",
    justifySelf: "end",
  },
  // At the row's end, #2503 sets its controls a space-2 apart, where
  // Damsko's tools stand a space-1 apart: the rest after the first.
  apart: { marginInlineStart: space["1"] },
  // The files take the header's whole line, their cards 16px from the
  // card's top and side and the text 12px under them, as #2503's and as
  // Damsko's own PromptInputAttachments (its `attachments` style), which
  // shows only files the box keeps itself: the row keeps 4px of its own
  // round them for a focus ring.
  files: {
    position: "relative",
    zIndex: 2,
    flexBasis: `calc(100% + 2 * ${space["1"]})`,
    flexShrink: 0,
    minWidth: 0,
    marginInline: `calc(-1 * ${space["1"]})`,
    marginBlockStart: `calc(-1 * ${space["1"]})`,
    marginBlockEnd: `calc(${space["3"]} - ${space["1"]} - ${space["4"]})`,
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

/** Who makes `model`: the first part of its ID (`anthropic/…`). */
const makerOf = (model: string): string => model.split("/")[0] ?? "";

/** A maker as people know it: the AI provider's name, else its ID. */
const makerName = (maker: string): string => {
  const provider = aiProviderIdSchema.safeParse(maker);
  return provider.success ? aiProviders[provider.data].label : maker;
};

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
  const makers = [...new Set(models.map(makerOf))];
  const chosenMark = makerMark(makerOf(model));
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
        {chosenMark === undefined ? null : (
          <ModelSelectorLogo logo={chosenMark} />
        )}
        <ModelSelectorName>
          {level === undefined ? name : `${name} · ${level}`}
        </ModelSelectorName>
      </ModelSelectorTrigger>
      <ModelSelectorContent side="top">
        <ModelSelectorInput />
        {makers.length > 1 ? (
          <ModelSelectorMakers>
            {makers.map((maker) => {
              const mark = makerMark(maker);
              return (
                <ModelSelectorMaker
                  aria-label={makerName(maker)}
                  key={maker}
                  value={maker}
                  {...(mark === undefined ? {} : { logo: mark })}
                />
              );
            })}
          </ModelSelectorMakers>
        ) : null}
        <ModelSelectorList>
          <ModelSelectorEmpty />
          {makers.map((maker) => {
            const mark = makerMark(maker);
            return (
              <ModelSelectorGroup
                heading={makerName(maker)}
                key={maker}
                value={maker}
              >
                {models
                  .filter((each) => makerOf(each) === maker)
                  .map((each) => (
                    <ModelSelectorItem
                      {...(each === models[0]
                        ? { description: t`The default` }
                        : {})}
                      key={each}
                      value={each}
                    >
                      {mark === undefined ? null : (
                        <ModelSelectorLogo logo={mark} />
                      )}
                      <ModelSelectorName>{modelName(each)}</ModelSelectorName>
                    </ModelSelectorItem>
                  ))}
              </ModelSelectorGroup>
            );
          })}
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

/** The add menu: files or photos. */
const AddMenu = () => {
  const { t } = useLingui();
  return (
    <PromptInputActionMenu>
      <PromptInputActionMenuTrigger aria-label={t`Add`} />
      <PromptInputActionMenuContent>
        <PromptInputActionAddAttachments>
          {t`Add files or photos`}
        </PromptInputActionAddAttachments>
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  );
};

/**
 * The box's tools: at the start the add menu and what answers; at the end
 * the microphone, Send (or Stop) and what the page adds. In one row the
 * text stands between the two, and what answers stands at the end, before
 * the microphone, as #2503's bar has it (on a phone once something is
 * typed).
 */
const BoxTools = ({
  attaches,
  compact,
  typed,
  answerer,
  speech,
  stop,
  children,
}: {
  attaches: boolean;
  compact: boolean;
  /** Something is typed: in one row on a phone, what answers shows only then. */
  typed: boolean;
  answerer: ReactNode;
  speech: PromptInputSpeechButtonProps | undefined;
  stop: (() => void) | undefined;
  children: ReactNode;
}) => {
  // In one row on a phone, what answers folds away at rest, so the
  // placeholder keeps its room, as #2503's row does.
  const phone = useNarrow();
  const folded = compact && phone && !typed;
  return (
    <>
      <PromptInputTools>
        {attaches ? <AddMenu /> : null}
        {compact ? null : answerer}
      </PromptInputTools>
      <PromptInputTools style={styles.end}>
        {compact && !folded ? answerer : null}
        {speech === undefined ? null : (
          <PromptInputSpeechButton
            {...speech}
            {...(compact ? { style: styles.apart } : {})}
          />
        )}
        <PromptInputSubmit
          {...(stop === undefined ? {} : { onStop: stop })}
          {...(compact || speech !== undefined ? { style: styles.apart } : {})}
        />
        {children}
      </PromptInputTools>
    </>
  );
};

/** What answers: the agent, and the model it answers with, or the one to pick. */
const Answerer = ({
  agent,
  agentModel,
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
}: {
  agent: ReactNode;
  agentModel: string | undefined;
  models: readonly string[];
  model: string | undefined;
  onModel: ((model: string) => void) | undefined;
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: ((effort: ModelEffort) => void) | undefined;
}) => (
  <>
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
  </>
);

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

/**
 * What the question is about, on the band above the box (subject-bar.tsx):
 * the kind's mark, the line (its name), and what else at its end ("+N").
 */
export interface SubjectBar {
  icon: IconData;
  line: ReactNode;
  more: ReactNode;
}

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

/**
 * No AI provider to call yet: the box's banner, with the way to connect one
 * for whoever can (`canConnect`). Made by a call, not a component of its
 * own: PromptInput finds its banner and note among its own children only.
 */
const noProviderBanner = (canConnect: boolean) => (
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

/** What the question is about, as the band above the box; a call too, as `noProviderBanner`. */
const subjectBanner = (subject: SubjectBar | undefined) =>
  subject === undefined ? null : (
    <PromptInputBanner action={subject.more} icon={subject.icon}>
      {subject.line}
    </PromptInputBanner>
  );

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
 * box saying it goes, and sent once core has, with no second press. Stop
 * lets a held question go unsent; when core can't say which models there
 * are (`unavailable`, why), it goes unsent too, and the box says why, its
 * words kept. Never while Grasp answers or a question is on its way, nor
 * with nothing typed.
 */
const useSend = ({
  text,
  running,
  busy,
  offered,
  model,
  unavailable,
  onSend,
}: {
  text: string;
  running: boolean;
  busy: boolean;
  offered: readonly string[] | undefined;
  model: string | undefined;
  unavailable: string | undefined;
  onSend: () => void;
}): {
  held: boolean;
  /** Why a held question didn't go. */
  heldFailure: string | undefined;
  submit: () => void;
  /** Lets a held question go unsent. */
  letGo: () => void;
} => {
  const asked = !running && text.trim() !== "";
  const canSend = asked && !busy && !lacksModel(model);
  const loadingModels = offered === undefined && lacksModel(model);
  const [held, setHeld] = useState(false);
  const [heldFailure, setHeldFailure] = useState<string>();
  // How many held questions were let go: each sends once, after the render.
  const [released, setReleased] = useState(0);
  if (held && unavailable !== undefined) {
    setHeld(false);
    setHeldFailure(unavailable);
  } else if (held && !loadingModels) {
    setHeld(false);
    setReleased(released + 1);
  }
  // Typing again takes the held question's failure away, as a send's; so
  // does reading the models once more and finding them (Try again).
  const [failedOn, setFailedOn] = useState(text);
  if (
    heldFailure !== undefined &&
    (failedOn !== text || unavailable === undefined)
  ) {
    setHeldFailure(undefined);
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
    heldFailure,
    submit: () => {
      setHeldFailure(undefined);
      if (canSend) {
        onSend();
      } else if (asked && loadingModels && unavailable !== undefined) {
        setFailedOn(text);
        setHeldFailure(unavailable);
      } else if (asked && loadingModels) {
        setFailedOn(text);
        setHeld(true);
      }
    },
    letGo: () => {
      setHeld(false);
    },
  };
};

/**
 * The box's value, which follows the page's words: where the page sets
 * other words (cleared once sent, a question picked under the box, an
 * agent named), the box takes them, its mentions as tokens.
 */
const useBoxValue = (
  text: string,
  mentions: readonly BoxMention[]
): [BoxValue, (value: BoxValue) => void] => {
  const [value, setValue] = useState<BoxValue>(() => valueFor(text, mentions));
  if (textOf(value) !== text) {
    setValue(valueFor(text, mentions));
  }
  return [value, setValue];
};

/** The box to ask in. Controlled: the page keeps the text and the model. */
export const Composer = ({
  text,
  onText,
  stopNote,
  mentions = noMentions,
  onMentions,
  models: offered,
  model,
  onModel,
  efforts = noLevels,
  effort,
  onEffort,
  unavailable,
  running,
  busy,
  failure,
  onSend,
  onStop,
  compact = false,
  dictates = true,
  label,
  placeholder,
  children,
  subject,
  files = noFiles,
  onAttach,
  onRemoveFile,
  agent,
  agentModel,
  style,
}: {
  text: string;
  onText: (text: string) => void;
  /**
   * Why dictating stopped on its own, kept where the text is: a box that
   * goes mid-dictation leaves the line under it to the box that comes.
   */
  stopNote?: StopNote;
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
  /** Why core can't say which models there are, while it can't: a question held for them goes unsent. */
  unavailable?: string;
  /** Whether Grasp is answering in this chat now. */
  running: boolean;
  /** Whether a question or a stop is on its way to core. */
  busy: boolean;
  /** Why the last question didn't go, under the box; its words are kept. */
  failure?: string;
  onSend: () => void;
  /** Stops the answer being written; only where one can be. */
  onStop?: () => void;
  /** One row, its tools, the text and Send side by side: the chat's idle bar. */
  compact?: boolean;
  /** Whether it offers dictation now: not while it is out of sight. */
  dictates?: boolean;
  /** What the box is called; "Your question" without it. */
  label?: string;
  placeholder?: string;
  /** After Send: such as the way to open the chat from its bar. */
  children?: ReactNode;
  /** What the question is about: a band above the box, tucked under its top. */
  subject?: SubjectBar;
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
  /** Layout only: where the box sits and how wide it is (Damsko's PromptInput's own width at most, by default). */
  style?: LayoutStyle;
}) => {
  const { t } = useLingui();
  const mentioning = onMentions !== undefined;
  const [value, setValue] = useBoxValue(text, mentions);
  const models = offered ?? noModels;
  // No AI provider to call yet: the box takes nothing. Not while the models
  // are still being read, so what is typed then stays.
  const noProvider = offered !== undefined && lacksModel(model);
  const dictation = useDictation(text, onText, {
    off: !dictates,
    note: stopNote,
  });
  const { held, heldFailure, submit, letGo } = useSend({
    text,
    running,
    busy,
    offered,
    model,
    unavailable,
    onSend,
  });
  const failed = heldFailure ?? failure;
  const note = dictation.problem ?? failed;
  const canConnect = useMemberAdmin();
  const answerer = (
    <Answerer
      agent={agent}
      agentModel={agentModel}
      effort={effort}
      efforts={efforts}
      model={model}
      models={models}
      onEffort={onEffort}
      onModel={onModel}
    />
  );

  return (
    <PromptInput
      compact={compact}
      disabled={noProvider}
      maxLength={maxQuestionLength}
      onSubmit={() => {
        // What this send meets is newer than why dictating stopped before it.
        dictation.clearProblem();
        submit();
      }}
      onValueChange={(next) => {
        setValue(next);
        onText(textOf(next));
        onMentions?.(mentionsOf(next));
      }}
      status={promptStatusOf({
        running,
        busy: busy || held,
        failed: failed !== undefined,
      })}
      {...(style === undefined ? {} : { style })}
      value={value}
    >
      {/* The band above the box: no AI provider yet, else what the
          question is about. */}
      {noProvider ? noProviderBanner(canConnect) : subjectBanner(subject)}
      {/* Under the box: why dictating stopped, else why the last question
          didn't go. Each send clears the first, so the newest shows. */}
      {note === undefined ? null : <PromptInputNote>{note}</PromptInputNote>}
      {files.length === 0 ? null : (
        <PromptInputHeader>
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
        <BoxTools
          answerer={answerer}
          typed={text.trim() !== ""}
          attaches={onAttach !== undefined}
          compact={compact}
          speech={dictation.speech}
          // Stop lets a held question go; else it stops the answer, where one can be.
          stop={held ? letGo : onStop}
        >
          {children}
        </BoxTools>
      </PromptInputFooter>
      {mentioning ? <BoxMentions /> : null}
      {/* Without a way to attach, what is dropped or pasted goes nowhere. */}
      <FilesToPage onAttach={onAttach} />
    </PromptInput>
  );
};
