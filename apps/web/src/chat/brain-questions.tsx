import type { Gap } from "@grasp-os/shared/brain";
import { brainGapTextMaxLength } from "@grasp-os/shared/brain-records";
import { failureText } from "@grasp-os/shared/errors";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { PauseNote, useAnswersPause } from "../answer-pause.tsx";
import type { Session } from "../core.ts";
import { useCore } from "../use-core.ts";
import { FailureLine } from "./failure-line.tsx";

// The brain's open questions in the brain's chat (GRA-531, GRA-936), as
// in the prototype (`knowledge/brain-chat.tsx`): each to answer there, in
// the person's own words, or to ask the role that can: core delivers the
// question to the members holding that role on the staff list, in their
// inbox, and refuses when nobody can receive it, so "asked" only shows
// once someone was. Both go through core's brain (`brain.answerGap`,
// `brain.askAboutGap`), which decides who may: any member answers, never
// Grasp's staff; only the company's own admins ask, or close one that
// needs no answer (`brain.closeGap`). The buttons follow what core allows, but
// core is what refuses. An answer is the person's own act here: the
// chat's agent only reads the questions, never answers them.

const styles = stylex.create({
  section: {
    display: "grid",
    gap: space["2"],
    flexShrink: 0,
    maxHeight: "12rem",
    overflowY: "auto",
    paddingInline: space["4"],
    paddingBlock: space["2"],
  },
  list: {
    display: "grid",
    gap: space["3"],
    margin: 0,
    paddingInlineStart: 0,
    listStyleType: "none",
  },
  question: { display: "grid", gap: space["1"] },
  presses: { display: "flex", flexWrap: "wrap", gap: space["1"] },
});

/** The questions nobody has answered or closed yet, in the order the brain keeps them. */
export const openGaps = (gaps: Gap[]): Gap[] =>
  gaps.filter(({ closedAt }) => closedAt === undefined);

/** A question, and what can be done about it. */
const Question = ({
  gap,
  canAnswer,
  canAsk,
  busy,
  pausedBy,
  onAnswer,
  onAsk,
  onClose,
}: {
  gap: Gap;
  canAnswer: boolean;
  /** Asking its owner, and closing it without an answer: the company's admins. */
  canAsk: boolean;
  busy: boolean;
  /**
   * The line that says Ask and Close wait a moment, while they do: one
   * question was just dealt with, and this one may have moved into its place.
   */
  pausedBy: string | undefined;
  onAnswer: (answer: string) => Promise<boolean>;
  onAsk: () => Promise<void>;
  onClose: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const asked = gap.askedAt !== undefined;
  const send = async (): Promise<void> => {
    if (await onAnswer(draft)) {
      setWriting(false);
      setDraft("");
    }
  };
  return (
    <li {...stylex.props(styles.question)}>
      <Text as="p" size="sm">
        {gap.question}
      </Text>
      <Text as="p" color="muted" size="xs">
        {asked ? (
          <Trans>For {gap.owner}, who was asked</Trans>
        ) : (
          <Trans>For {gap.owner}</Trans>
        )}
      </Text>
      {writing ? (
        <div {...stylex.props(styles.question)}>
          <Field name={`answer-${gap.id}`}>
            <FieldLabel>{t`Your answer`}</FieldLabel>
            <Textarea
              disabled={busy}
              maxLength={brainGapTextMaxLength}
              onValueChange={setDraft}
              rows={3}
              value={draft}
            />
          </Field>
          <div {...stylex.props(styles.presses)}>
            <Button
              disabled={busy || draft.trim() === ""}
              onClick={() => {
                void send();
              }}
              size="xs"
            >
              <Trans>Send answer</Trans>
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setWriting(false);
              }}
              size="xs"
              variant="ghost"
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <div {...stylex.props(styles.presses)}>
          {canAnswer ? (
            <Button
              disabled={busy}
              onClick={() => {
                setWriting(true);
              }}
              size="xs"
              variant="outline"
            >
              <Trans>Answer</Trans>
            </Button>
          ) : null}
          {canAsk && !asked ? (
            <Button
              aria-describedby={pausedBy}
              disabled={busy || pausedBy !== undefined}
              focusableWhenDisabled={pausedBy !== undefined}
              onClick={() => {
                void onAsk();
              }}
              size="xs"
              variant="outline"
            >
              <Trans>Ask {gap.owner}</Trans>
            </Button>
          ) : null}
          {canAsk ? (
            <Button
              aria-describedby={pausedBy}
              disabled={busy || pausedBy !== undefined}
              focusableWhenDisabled={pausedBy !== undefined}
              onClick={() => {
                void onClose();
              }}
              size="xs"
              variant="ghost"
            >
              <Trans>Close without an answer</Trans>
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
};

/**
 * The brain's open questions, between the brain chat's thread and its box:
 * nothing while there are none. `onChanged` is told when one was answered or
 * asked about, so the brain is read again.
 */
export const BrainQuestions = ({
  gaps,
  identity,
  onChanged,
}: {
  gaps: Gap[];
  identity: Pick<Identity, "role" | "staff">;
  onChanged: () => void;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  // Once one is asked about or closed, the questions under it move up:
  // Ask and Close hold a moment, so the second press of a double click
  // never deals with the question that took its place (answer-pause.tsx).
  const pause = useAnswersPause();
  const pauseId = useId();
  const pausedBy = pause.held ? pauseId : undefined;
  const open = openGaps(gaps);
  if (open.length === 0) {
    return null;
  }
  const change = async (
    action: (session: Session) => Promise<unknown>
  ): Promise<boolean> => {
    setBusy(true);
    setFailure(undefined);
    try {
      await core.withSession(action);
    } catch (error) {
      setFailure(failureText(error));
      setBusy(false);
      return false;
    }
    setBusy(false);
    pause.hold();
    onChanged();
    return true;
  };
  return (
    <section aria-label={t`Open questions`} {...stylex.props(styles.section)}>
      <Text as="p" color="muted" size="xs" weight="medium">
        <Trans>Open questions</Trans>
      </Text>
      <ul {...stylex.props(styles.list)}>
        {open.map((gap) => (
          <Question
            busy={busy}
            canAnswer={!identity.staff}
            canAsk={isMemberAdmin(identity)}
            gap={gap}
            key={gap.id}
            pausedBy={pausedBy}
            onAnswer={async (answer) =>
              await change(
                async (session) => await session.brain.answerGap(gap.id, answer)
              )
            }
            onAsk={async () => {
              await change(
                async (session) => await session.brain.askAboutGap(gap.id)
              );
            }}
            onClose={async () => {
              await change(
                async (session) => await session.brain.closeGap(gap.id)
              );
            }}
          />
        ))}
      </ul>
      {pause.held ? <PauseNote id={pauseId} /> : null}
      <FailureLine>{failure}</FailureLine>
    </section>
  );
};
