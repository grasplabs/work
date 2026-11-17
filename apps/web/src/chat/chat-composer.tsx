import type { ModelEffort } from "@grasp-os/shared/models";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { ConnectAiProvider } from "../frame/connect-ai-provider.tsx";
import {
  Composer,
  ComposerAdd,
  ComposerSurface,
} from "../grasp/composer/index.ts";
import { Text } from "../grasp/text/index.ts";
import { accepted, useAttachmentWords } from "./chat-files.tsx";
import type { CardFile } from "./chat-files.tsx";
import { useComposerMentions } from "./mentions.tsx";
import type { Mentionable } from "./mentions.tsx";
import { ModelControls } from "./model-controls.tsx";
import { lacksModel, maxQuestionLength, modelName } from "./model-names.tsx";

// The running chat's box to ask in, on Grasp UI's Composer, fed by the
// same ask as before (use-ask.ts): the text, the model and how hard it
// thinks, the files the question carries (dropped, pasted, or taken off
// again), and Stop while Grasp answers, when the light travels round the
// card. While the organization has no AI provider, the box takes nothing
// and says how to connect one under it.

const styles = stylex.create({
  // As wide as the chat's column: the thread above it sets the width.
  fill: {
    maxWidth: "100%",
  },
});

/** Where nobody picks how hard the model thinks. */
const noLevels: readonly ModelEffort[] = [];

/** Where nothing is mentioned. */
const noMentions: readonly Mentionable[] = [];

/** Where no file waits for the question. */
const noFiles: readonly CardFile[] = [];

/** What the running chat's box needs: the ask (use-ask.ts) and what the page adds. */
export interface ChatComposerProps {
  text: string;
  onText: (text: string) => void;
  /** What is typed mentions (`@`): an App, a workflow or someone, by ID. */
  mentions?: readonly Mentionable[];
  onMentions?: (mentions: readonly Mentionable[]) => void;
  /** The models a question may name, the default first; undefined while core hasn't said which. */
  models?: readonly string[];
  model?: string;
  onModel?: (model: string) => void;
  efforts?: readonly ModelEffort[];
  effort?: ModelEffort;
  onEffort?: (effort: ModelEffort) => void;
  /** Whether Grasp is answering in this chat now. */
  running: boolean;
  /** Whether a question or a stop is on its way to core. */
  busy: boolean;
  failure?: string;
  onSend: () => void;
  onStop?: () => void;
  /** What the box is called, for a screen reader. */
  label?: string;
  placeholder?: string;
  /** At the footer's end, before send: the recent chats. */
  actions?: ReactNode;
  /** What the question is about: a band over the text. */
  subject?: ReactNode;
  /** Which agent answers, at the footer's start (agent-choice.tsx). */
  agent?: ReactNode;
  /** The model the chat's agent answers with, where an admin gave it one: said, with nothing to pick. */
  agentModel?: string;
  /** The files the question will carry. */
  files?: readonly CardFile[];
  onAttach?: (files: readonly File[]) => void;
  onRemoveFile?: (id: string) => void;
  /** One row, the actions beside the text: a guest's chat. */
  compact?: boolean;
  /** Takes nothing for now, while something else is on its way to core. */
  disabled?: boolean;
  /** The longest message it takes; a question's by default. */
  maxLength?: number;
  /** What takes the text's place while the assistant needs something first: its questions. */
  takeover?: ReactNode;
  /** Escape, or Type instead, leaves the takeover for the text. */
  onTakeoverDismiss?: () => void;
}

/** Where the assistant is, as the Composer shows it: answering, out of use, or waiting. */
const activityOf = (
  running: boolean,
  off: boolean,
  /** What stands in the text's place: the questions say themselves when nothing can be sent. */
  takeover: ReactNode
): "idle" | "working" | "disabled" => {
  if (running) {
    return "working";
  }
  return off && takeover === undefined ? "disabled" : "idle";
};

/**
 * The model a question names and how hard it thinks, to pick; or the model
 * the chat's agent answers with, where an admin gave it one, said with
 * nothing to pick.
 */
const Controls = ({
  agentModel,
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
}: Pick<
  ChatComposerProps,
  "agentModel" | "models" | "model" | "onModel" | "effort" | "onEffort"
> & { efforts: readonly ModelEffort[] }) => {
  const { t } = useLingui();
  if (agentModel !== undefined) {
    const name = modelName(agentModel);
    return (
      <Text size="sm" tone="muted">
        {t`${name}, set for this agent`}
      </Text>
    );
  }
  return (
    <ModelControls
      effort={effort}
      efforts={efforts}
      model={model ?? ""}
      models={models}
      onEffort={(chosen) => {
        onEffort?.(chosen);
      }}
      onModel={(chosen) => {
        onModel?.(chosen);
      }}
    />
  );
};

/** The running chat's box to ask in. Controlled: the page keeps the text and the model. */
export const ChatComposer = ({
  text,
  onText,
  models,
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
  label,
  placeholder,
  actions,
  subject,
  agent,
  agentModel,
  files = noFiles,
  onAttach,
  onRemoveFile,
  mentions = noMentions,
  onMentions,
  compact = false,
  disabled = false,
  maxLength = maxQuestionLength,
  takeover,
  onTakeoverDismiss,
}: ChatComposerProps) => {
  const { t } = useLingui();
  const attachmentWords = useAttachmentWords("waiting");
  const mentioning = useComposerMentions(mentions, onMentions);
  // No AI provider to call yet: the box takes nothing. Not while the models
  // are still being read, so what is typed then stays.
  const noProvider = models !== undefined && lacksModel(model);
  return (
    <Composer
      activity={activityOf(running, noProvider || disabled, takeover)}
      compact={compact}
      attachments={files.map(({ id, name, bytes }) => ({
        id,
        name,
        size: bytes,
        // A file goes up only as the question is sent, and how far it has
        // gone is not known: each shows its size until then, not a progress.
        status: "done",
      }))}
      attachmentsLabel={t`Files to send`}
      attachmentWords={attachmentWords}
      start={
        <>
          {onAttach === undefined ? null : (
            <ComposerAdd
              accept={accepted}
              kinds={mentioning?.kinds}
              label={t`Add to the question`}
              onAttach={(chosen) => {
                onAttach(chosen);
              }}
              uploadLabel={t`Attach a file`}
            />
          )}
          {agent}
        </>
      }
      controls={
        <Controls
          agentModel={agentModel}
          effort={effort}
          efforts={efforts}
          model={model}
          models={models}
          onEffort={onEffort}
          onModel={onModel}
        />
      }
      end={actions}
      failedLabel={t`Could not send`}
      label={label ?? t`Your question`}
      layout={styles.fill}
      note={noProvider ? <ConnectAiProvider size="xs" /> : undefined}
      onAttach={
        onAttach === undefined
          ? undefined
          : (chosen) => {
              onAttach(chosen);
            }
      }
      // Not removable while the question is on its way with them.
      onRemoveAttachment={busy ? undefined : onRemoveFile}
      onSend={() => {
        if (!busy) {
          onSend();
        }
      }}
      onStop={onStop}
      mentionItems={mentioning?.items}
      mentionKinds={mentioning?.kinds}
      mentionsEmptyLabel={t`Nothing found`}
      mentionsLoading={mentioning?.loading}
      onMention={(item) => {
        mentioning?.onMention(item);
      }}
      onValueChange={(value) => {
        // The Composer takes no length of its own: past it, nothing more is typed.
        const kept = value.slice(0, maxLength);
        onText(kept);
        mentioning?.onText(kept);
      }}
      placeholder={placeholder ?? t`Ask anything, or describe a process`}
      sendLabel={t({ message: "Send", context: "send the question" })}
      stopLabel={t({ message: "Stop", context: "stop the answer" })}
      onTakeoverDismiss={onTakeoverDismiss}
      takeover={takeover}
      top={
        subject === undefined ? undefined : (
          <ComposerSurface>{subject}</ComposerSurface>
        )
      }
      validation={failure}
      value={text}
      workingLabel={t`Grasp is answering`}
    />
  );
};
