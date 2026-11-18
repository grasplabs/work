import type { Gap } from "@grasp-os/shared/brain";
import { brainGapTextMaxLength } from "@grasp-os/shared/brain-records";
import { failureText } from "@grasp-os/shared/errors";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { Button } from "../grasp/button/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";

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
  // Between the thread and the box, its own scroll.
  section: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    maxHeight: "12rem",
    overflowY: "auto",
    paddingInline: grasp.space4,
    paddingBlock: grasp.space2,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  heading: {
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
  },
  list: { margin: 0, padding: 0, listStyle: "none" },
  question: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    paddingBlock: grasp.space2,
    borderBlockEndWidth: { default: 1, ":last-child": 0 },
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  writing: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  row: { display: "flex", flexWrap: "wrap", gap: grasp.space1 },
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
  onAnswer,
  onAsk,
  onClose,
}: {
  gap: Gap;
  canAnswer: boolean;
  /** Asking its owner, and closing it without an answer: the company's admins. */
  canAsk: boolean;
  busy: boolean;
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
      <Text>{gap.question}</Text>
      <Text size="xs" tone="muted">
        {asked ? (
          <Trans>For {gap.owner}, who was asked</Trans>
        ) : (
          <Trans>For {gap.owner}</Trans>
        )}
      </Text>
      {writing ? (
        <div {...stylex.props(styles.writing)}>
          <Textarea
            aria-label={t`Your answer`}
            disabled={busy}
            maxLength={brainGapTextMaxLength}
            onValueChange={setDraft}
            rows={3}
            value={draft}
          />
          <div {...stylex.props(styles.row)}>
            <Button
              disabled={busy || draft.trim() === ""}
              onClick={() => {
                void send();
              }}
              size="xs"
              variant="ink"
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
        <div {...stylex.props(styles.row)}>
          {canAnswer ? (
            <Button
              disabled={busy}
              onClick={() => {
                setWriting(true);
              }}
              size="xs"
              variant="quiet"
            >
              <Trans>Answer</Trans>
            </Button>
          ) : null}
          {canAsk && !asked ? (
            <Button
              disabled={busy}
              onClick={() => {
                void onAsk();
              }}
              size="xs"
              variant="quiet"
            >
              <Trans>Ask {gap.owner}</Trans>
            </Button>
          ) : null}
          {canAsk ? (
            <Button
              disabled={busy}
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
    onChanged();
    return true;
  };
  return (
    <section aria-label={t`Open questions`} {...stylex.props(styles.section)}>
      <h3 {...stylex.props(styles.heading)}>
        <Trans>Open questions</Trans>
      </h3>
      <ul {...stylex.props(styles.list)}>
        {open.map((gap) => (
          <Question
            busy={busy}
            canAnswer={!identity.staff}
            canAsk={isMemberAdmin(identity)}
            gap={gap}
            key={gap.id}
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
      <ErrorText>{failure}</ErrorText>
    </section>
  );
};
