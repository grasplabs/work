import type { Gap } from "@grasp-os/shared/brain";
import { brainGapTextMaxLength } from "@grasp-os/shared/brain-records";
import { failureText } from "@grasp-os/shared/errors";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";

// The brain's open questions in the brain's chat (GRA-531, GRA-936), as
// in the prototype (`knowledge/brain-chat.tsx`): each to answer there, in
// the person's own words, or to ask the role that can: core delivers the
// question to the members holding that role on the staff list, in their
// inbox, and refuses when nobody can receive it, so "asked" only shows
// once someone was. Both go through core's brain (`brain.answerGap`,
// `brain.askAboutGap`), which decides who may: any member answers, never
// Grasp's staff; only the company's own admins ask. The buttons follow what core allows, but
// core is what refuses. An answer is the person's own act here: the
// chat's agent only reads the questions, never answers them.

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
}: {
  gap: Gap;
  canAnswer: boolean;
  canAsk: boolean;
  busy: boolean;
  onAnswer: (answer: string) => Promise<boolean>;
  onAsk: () => Promise<void>;
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
    <li className="flex flex-col gap-1.5 py-2">
      <p>{gap.question}</p>
      <p className="text-muted-foreground text-xs">
        {asked ? (
          <Trans>For {gap.owner}, who was asked</Trans>
        ) : (
          <Trans>For {gap.owner}</Trans>
        )}
      </p>
      {writing ? (
        <div className="flex flex-col gap-1.5">
          <Textarea
            aria-label={t`Your answer`}
            disabled={busy}
            maxLength={brainGapTextMaxLength}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            rows={3}
            value={draft}
          />
          <div className="flex gap-1.5">
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
        <div className="flex gap-1.5">
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
              disabled={busy}
              onClick={() => {
                void onAsk();
              }}
              size="xs"
              variant="outline"
            >
              <Trans>Ask {gap.owner}</Trans>
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
    <section
      aria-label={t`Open questions`}
      className="flex max-h-48 flex-none flex-col overflow-y-auto border-t px-4 py-2"
    >
      <h3 className="text-muted-foreground text-xs font-medium">
        <Trans>Open questions</Trans>
      </h3>
      <ul className="divide-y">
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
          />
        ))}
      </ul>
      <ErrorText>{failure}</ErrorText>
    </section>
  );
};
