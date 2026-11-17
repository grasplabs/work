import type { ModelEffort } from "@grasp-os/shared/models";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { formatNumber } from "../format.ts";
import { ConnectAiProvider } from "../frame/connect-ai-provider.tsx";
import {
  Composer,
  ComposerAdd,
  ComposerSurface,
} from "../grasp/composer/index.ts";
import type { ComposerFile } from "../grasp/composer/index.ts";
import { accepted, useAttachmentWords } from "./chat-files.tsx";
import type { CardFile } from "./chat-files.tsx";
import { useComposerMentions } from "./mentions.tsx";
import type { Mentionable } from "./mentions.tsx";
import { ModelControls } from "./model-controls.tsx";
import { lacksModel, maxQuestionLength } from "./model-names.tsx";
import { useDictation } from "./use-dictation.ts";

// The box to ask in, everywhere work asks Grasp (Chat start, the chat's
// page and the docked chat), as Grasp UI's reference for a chat product
// has it: `start` the plus (files and mentions) where there is something
// to add, `controls` the model and how hard it thinks, `end` empty. Fed by
// the same ask as before (use-ask.ts): the text, the model and effort, the
// files the question carries (dropped, pasted, or taken off again), and
// Stop while Grasp answers, when the light travels round the card. While
// the organization has no AI provider, the box takes nothing and says how
// to connect one under it.

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
  /** Why the last question didn't go, said under the box; Send tries again. */
  failure?: string;
  /** Why a file the person chose stays out of the box. */
  fileProblem?: string;
  /** Sends the question; rejects when it didn't go, which the box says (`failure`). */
  onSend: () => Promise<void> | void;
  onStop?: () => void;
  /** What the box is called, for a screen reader. */
  label?: string;
  placeholder?: string;
  /** What the question is about: a band over the text. */
  subject?: ReactNode;
  /** The model the chat's agent answers with, where an admin gave it one: the only one offered. */
  agentModel?: string;
  /** The files the question will carry. */
  files?: readonly CardFile[];
  onAttach?: (files: readonly File[]) => void;
  onRemoveFile?: (id: string) => void;
  /** One row, the actions beside the text: a guest's chat. */
  compact?: boolean;
  /** Glass over a backdrop: Chat start's. */
  surface?: "card" | "glass";
  /** After send: a control not about this message, such as the idle bar's Open the chat. */
  footer?: ReactNode;
  /**
   * Its working mark and words under it while Grasp answers: where no
   * thread shows Grasp at work (the idle bar). Beside a thread, the
   * thread's activity line is the one working mark.
   */
  showWorking?: boolean;
  /** Takes nothing for now, while something else is on its way to core. */
  disabled?: boolean;
  /** The longest message it takes; a question's by default. */
  maxLength?: number;
  /** What takes the text's place while the assistant needs something first: its questions. */
  takeover?: ReactNode;
  /** Escape, or Type instead, leaves the takeover for the text. */
  onTakeoverDismiss?: () => void;
}

/**
 * The files the question carries, as the Composer shows them. A file goes
 * up only as the question is sent, and how far it has gone is not known:
 * each shows its size until then, not a progress.
 */
const attachmentsOf = (files: readonly CardFile[]): ComposerFile[] =>
  files.map(({ id, name, bytes }) => ({
    id,
    name,
    size: bytes,
    status: "done",
  }));

/**
 * The line under the box: how to connect an AI provider while there is
 * none, else why a file stayed out or why the last question didn't go
 * (from the box, or from Try again in the thread). Said, never a reason to
 * hold the next question back, as `validation` would.
 */
const noteOf = (noProvider: boolean, problem: string | undefined) =>
  noProvider ? <ConnectAiProvider size="xs" /> : problem;

/** What the box says as the text nears and reaches its longest, in the page's language. */
const useLengthWords = () => {
  const { t } = useLingui();
  return {
    maxLengthCountLabel: (length: number, max: number) =>
      `${formatNumber(length)}/${formatNumber(max)}`,
    maxLengthCutLabel: (max: number) => {
      const limit = formatNumber(max);
      return t`The pasted text was cut at the limit of ${limit} characters`;
    },
    maxLengthNearLabel: (max: number) => {
      const limit = formatNumber(max);
      return t`Close to the limit of ${limit} characters`;
    },
    maxLengthReachedLabel: (max: number) => {
      const limit = formatNumber(max);
      return t`The limit of ${limit} characters is reached`;
    },
  };
};

/**
 * Whether Grasp has just finished an answer here: from the moment it stops
 * working until it works again. The Composer plays its halo once for it.
 */
const useJustAnswered = (running: boolean): boolean => {
  const [was, setWas] = useState(running);
  const [answered, setAnswered] = useState(false);
  if (was !== running) {
    setWas(running);
    setAnswered(was);
  }
  return answered && !running;
};

/** Where the assistant is, as the Composer shows it: answering, just done, out of use, or waiting. */
const activityOf = (
  running: boolean,
  answered: boolean,
  off: boolean,
  /** What stands in the text's place: the questions say themselves when nothing can be sent. */
  takeover: ReactNode
): "idle" | "working" | "success" | "disabled" => {
  if (running) {
    return "working";
  }
  if (off && takeover === undefined) {
    return "disabled";
  }
  return answered ? "success" : "idle";
};

/** The box to ask in. Controlled: the page keeps the text and the model. */
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
  fileProblem,
  onSend,
  onStop,
  label,
  placeholder,
  subject,
  agentModel,
  files = noFiles,
  onAttach,
  onRemoveFile,
  mentions = noMentions,
  onMentions,
  compact = false,
  surface,
  footer,
  showWorking,
  disabled = false,
  maxLength = maxQuestionLength,
  takeover,
  onTakeoverDismiss,
}: ChatComposerProps) => {
  const { t } = useLingui();
  const lengthWords = useLengthWords();
  const attachmentWords = useAttachmentWords("waiting");
  const mentioning = useComposerMentions(mentions, onMentions);
  // No AI provider to call yet: the box takes nothing. Not while the models
  // are still being read, so what is typed then stays.
  const noProvider = models !== undefined && lacksModel(model);
  const answered = useJustAnswered(running);
  const dictating = useDictation(text, onText);
  return (
    <Composer
      activity={activityOf(running, answered, noProvider || disabled, takeover)}
      footer={footer}
      {...dictating}
      showWorking={showWorking}
      compact={compact}
      attachments={attachmentsOf(files)}
      attachmentsLabel={t`Files to send`}
      attachmentWords={attachmentWords}
      start={
        onAttach === undefined ? undefined : (
          <ComposerAdd
            accept={accepted}
            kinds={mentioning?.kinds}
            aria-label={t`Add to the question`}
            onAttach={(chosen) => {
              onAttach(chosen);
            }}
            uploadLabel={t`Attach a file`}
          />
        )
      }
      controls={
        <ModelControls
          agentModel={agentModel}
          effort={effort}
          efforts={efforts}
          model={model}
          models={models}
          onEffort={onEffort}
          onModel={onModel}
        />
      }
      failedLabel={t`Could not send`}
      aria-label={label ?? t`Your question`}
      layout={styles.fill}
      note={noteOf(noProvider, fileProblem ?? failure)}
      onAttach={
        onAttach === undefined
          ? undefined
          : (chosen) => {
              onAttach(chosen);
            }
      }
      // Not removable while the question is on its way with them.
      onRemoveAttachment={busy ? undefined : onRemoveFile}
      onSend={async () => {
        if (!busy) {
          await onSend();
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
      maxLength={maxLength}
      {...lengthWords}
      onValueChange={(value) => {
        onText(value);
        mentioning?.onText(value);
      }}
      placeholder={placeholder ?? t`Ask anything, or describe a process`}
      sendLabel={t({ message: "Send", context: "send the question" })}
      stopLabel={t({ message: "Stop", context: "stop the answer" })}
      surface={surface}
      onTakeoverDismiss={onTakeoverDismiss}
      takeover={takeover}
      top={
        subject === undefined ? undefined : (
          <ComposerSurface>{subject}</ComposerSurface>
        )
      }
      value={text}
      workingLabel={t`Grasp is answering`}
    />
  );
};
