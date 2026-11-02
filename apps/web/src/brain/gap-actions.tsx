import type { Gap } from "@grasp-os/shared/brain";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouteContext, useRouter } from "@tanstack/react-router";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useBrainData } from "./brain-data.ts";

// What the company's admins do with one of the brain's questions on its
// note, beyond answering and asking (chat/brain-questions.tsx): close an
// open one that needs no answer (`brain.closeGap`), or take an answer away,
// and who gave it, keeping the question closed (`brain.redactGapAnswer`).
// Each is asked first, as neither can be undone. Core decides who may;
// the page offers them only to the company's own admins, as core does.

/** A change that can't be undone, asked first. */
const Confirmed = ({
  label,
  title,
  description,
  confirm,
  busy,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
}) => (
  <AlertDialog>
    <AlertDialogTrigger
      render={<Button disabled={busy} size="sm" variant="outline" />}
    >
      {label}
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm} variant="destructive">
          {confirm}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

const CloseGap = ({
  busy,
  onConfirm,
}: {
  busy: boolean;
  onConfirm: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Confirmed
      busy={busy}
      confirm={t`Close it`}
      description={t`It leaves the open questions, with no answer, and nobody is asked about it any more. It can't be opened again.`}
      label={t`Close without an answer`}
      onConfirm={onConfirm}
      title={t`Close this question without an answer?`}
    />
  );
};

const RedactAnswer = ({
  busy,
  onConfirm,
}: {
  busy: boolean;
  onConfirm: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Confirmed
      busy={busy}
      confirm={t`Redact it`}
      description={t`The answer, and who gave it, are taken away for good. The question stays closed.`}
      label={t`Redact the answer`}
      onConfirm={onConfirm}
      title={t`Redact this answer?`}
    />
  );
};

const Actions = ({ gap }: { gap: Gap }) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const closed = gap.closedAt !== undefined;
  const answered = gap.answer !== undefined && gap.answer !== "";
  const change = async (action: Parameters<typeof run>[0]): Promise<void> => {
    const done = await run(action);
    if (done !== undefined) {
      // The brain is read again: the question shows as it is now.
      await router.invalidate();
    }
  };
  return (
    <>
      {closed ? null : (
        <CloseGap
          busy={busy}
          onConfirm={() => {
            void change(
              async (session) => await session.brain.closeGap(gap.id)
            );
          }}
        />
      )}
      {answered ? (
        <RedactAnswer
          busy={busy}
          onConfirm={() => {
            void change(
              async (session) => await session.brain.redactGapAnswer(gap.id)
            );
          }}
        />
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** An admin's actions on the question `noteId` names, if it is one. */
export const GapActions = ({ noteId }: { noteId: string }) => {
  const { identity } = useRouteContext({ from: "/_shell" });
  const { workspace } = useBrainData();
  const gap = workspace.gaps.find(({ id }) => id === noteId);
  if (gap === undefined || !isMemberAdmin(identity)) {
    return null;
  }
  return <Actions gap={gap} />;
};
