import type { ModelEffort } from "@grasp-os/shared/models";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

import { Button } from "../grasp/button/index.ts";
import {
  Composer,
  ComposerAdd,
  ComposerSurface,
} from "../grasp/composer/index.ts";
import type { ComposerFile } from "../grasp/composer/index.ts";
import { Lock } from "../grasp/icons/index.ts";
import { useMemberAdmin } from "../use-member-admin.ts";
import { accepted, useAttachmentWords } from "./chat-files.tsx";
import type { CardFile } from "./chat-files.tsx";
import { useOwnComposerLook } from "./composer-look.ts";
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
  /** Sends the question. */
  onSend: () => Promise<void> | void;
  /** The last question didn't go: the box says Could not send, and why (`failure`), the words kept. */
  sendFailed?: boolean;
  /** Follows the box's own changes to `sendFailed`: typing again clears it. */
  onSendFailedChange?: (failed: boolean) => void;
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
  /** The box itself, for a holder that gives it the cursor. */
  boxRef?: Ref<HTMLTextAreaElement> | undefined;
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
 * While there is no AI provider, the band on top of the box says so in a
 * line (Grasp UI's ComposerSurface), with the way to Settings › AI
 * providers for whoever can connect one, and who to ask for anyone else:
 * the box stays where it is, at the page's foot.
 */
const NoProviderBand = () => {
  const { t } = useLingui();
  const canConnect = useMemberAdmin();
  return canConnect ? (
    <ComposerSurface
      action={
        <Button render={<Link to="/settings/ai-providers" />} size="sm">
          {t`Go to AI providers`}
        </Button>
      }
      icon={Lock}
    >
      {t`Connect an AI provider to start asking`}
    </ComposerSurface>
  ) : (
    <ComposerSurface icon={Lock}>
      {t`Ask your admin to connect an AI provider.`}
    </ComposerSurface>
  );
};

/** The band on top of the box: no AI provider yet, else what the chat is about. */
const topOf = (noProvider: boolean, subject: ReactNode): ReactNode =>
  noProvider ? <NoProviderBand /> : subject;

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

/**
 * Send, from the box: a press before core has said which models there
 * are waits for them and goes then, rather than being dropped while Send
 * looks ready; a press while a question is on its way is that question.
 */
const useSendOnceReady = (
  models: ChatComposerProps["models"],
  busy: boolean,
  onSend: () => void | Promise<void>
): (() => Promise<void>) => {
  // A press kept until the models are read: nothing to draw, so a ref.
  const waiting = useRef(false);
  const send = useEffectEvent(() => {
    waiting.current = false;
    void onSend();
  });
  const ready = models !== undefined && !busy;
  useEffect(() => {
    if (ready && waiting.current) {
      send();
    }
  }, [ready]);
  return async () => {
    if (models === undefined) {
      waiting.current = true;
    } else if (!busy) {
      await onSend();
    }
  };
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
  sendFailed,
  onSendFailedChange,
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
  boxRef,
  surface,
  footer,
  showWorking,
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
  const answered = useJustAnswered(running);
  const dictating = useDictation(text, onText);
  const look = useOwnComposerLook();
  const send = useSendOnceReady(models, busy, onSend);
  return (
    <Composer
      accent={look.accent}
      activity={activityOf(running, answered, noProvider || disabled, takeover)}
      edge={look.edge}
      footer={footer}
      {...dictating}
      showWorking={showWorking}
      compact={compact}
      attachments={attachmentsOf(files)}
      attachmentWords={attachmentWords}
      start={
        onAttach === undefined ? undefined : (
          <ComposerAdd
            accept={accepted}
            kinds={mentioning?.kinds}
            onAttach={(chosen) => {
              onAttach(chosen);
            }}
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
      aria-label={label ?? t`Your question`}
      ref={boxRef}
      layout={styles.fill}
      // Why a file stayed out or why the last question didn't go: said,
      // never a reason to hold the next question back, as `validation` would.
      note={fileProblem ?? failure}
      onAttach={
        onAttach === undefined
          ? undefined
          : (chosen) => {
              onAttach(chosen);
            }
      }
      // Not removable while the question is on its way with them.
      onRemoveAttachment={busy ? undefined : onRemoveFile}
      onSend={send}
      onStop={onStop}
      sendFailed={sendFailed}
      onSendFailedChange={onSendFailedChange}
      mentionItems={mentioning?.items}
      mentionKinds={mentioning?.kinds}
      mentionsLoading={mentioning?.loading}
      onMention={(item) => {
        mentioning?.onMention(item);
      }}
      maxLength={maxLength}
      onValueChange={(value) => {
        onText(value);
        mentioning?.onText(value);
      }}
      placeholder={placeholder ?? t`Ask anything, or describe a process`}
      surface={surface}
      onTakeoverDismiss={onTakeoverDismiss}
      takeover={takeover}
      // Its other words are the parts' catalogue's (frame/part-words.tsx).
      // The band above the box: what the chat is about (subject-bar.tsx).
      top={topOf(noProvider, subject)}
      value={text}
    />
  );
};
