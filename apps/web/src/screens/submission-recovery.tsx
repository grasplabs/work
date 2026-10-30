import type {
  ScreenSubmission,
  ScreenSubmissionStatus,
} from "@grasp-os/shared/submissions";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { HistoryIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Above an App's screen: what the person sent through its screens whose
// answer the page may never have shown them, because the tab closed or
// the connection dropped before it arrived (`screenSubmissions.list`,
// spec 10.7.8). Core keeps each by its status alone, never what it
// changed or answered, and only for the person who sent it. Each says how
// it came out, so the person can check before trying again, and is
// dismissed once they have (`screenSubmissions.dismiss`). Nothing shows
// while there is nothing to recover, and Grasp staff have none.

/** How a submission came out, in the page's language. */
const statusText: Record<ScreenSubmissionStatus, MessageDescriptor> = {
  pending: msg`Still running.`,
  saved: msg`It went through.`,
  failed: msg`It failed.`,
  not_saved: msg`Nothing was saved.`,
  uncertain: msg`Whether it went through can’t be told. Check before you try again.`,
  expired: msg`It’s too long ago to tell whether it went through. Check before you try again.`,
};

/** One submission, how it came out, and dismissing it. */
const SubmissionRow = ({
  submission,
  onDismissed,
}: {
  submission: ScreenSubmission;
  onDismissed: () => void;
}) => {
  const { t, i18n } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const { operation, failure: category } = submission;
  const sent = formatDateTime(submission.createdAt);
  const dismiss = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.screenSubmissions.dismiss(submission.id);
      return true;
    });
    if (done === true) {
      onDismissed();
    }
  };
  return (
    <li className="flex items-start justify-between gap-3 border-t py-2 first:border-t-0">
      <div className="flex min-w-0 flex-col">
        <span className="truncate">
          <code className="text-xs">{operation}</code>
          <span className="text-muted-foreground">
            {" "}
            · <time dateTime={submission.createdAt}>{sent}</time>
          </span>
        </span>
        <span className="text-muted-foreground">
          {i18n._(statusText[submission.status])}
          {category === null ? null : <> {t`Reason: ${category}.`}</>}
        </span>
        <ErrorText>{failure}</ErrorText>
      </div>
      <Button
        aria-label={t`Dismiss ${operation}, sent ${sent}`}
        disabled={busy}
        onClick={() => {
          void dismiss();
        }}
        size="sm"
        variant="ghost"
      >
        <Trans>Dismiss</Trans>
      </Button>
    </li>
  );
};

/** What `submissions` hold of this App, to recover; nothing when none. */
export const SubmissionRecoveryView = ({
  submissions,
  onDismissed,
}: {
  submissions: readonly ScreenSubmission[];
  onDismissed: (id: string) => void;
}) => {
  if (submissions.length === 0) {
    return null;
  }
  return (
    <Alert className="mx-4 mt-3 w-auto">
      <HistoryIcon />
      <AlertTitle>
        <Trans>Changes whose outcome you may not have seen</Trans>
      </AlertTitle>
      <AlertDescription>
        <p>
          <Trans>
            This app sent these, but the page may have closed or lost its
            connection before it showed how they came out. Check each, then
            dismiss it.
          </Trans>
        </p>
        <ul className="mt-2 w-full">
          {submissions.map((submission) => (
            <SubmissionRow
              key={submission.id}
              onDismissed={() => {
                onDismissed(submission.id);
              }}
              submission={submission}
            />
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
};

/** The person's submissions of `app` to recover, read when its screen opens. */
export const SubmissionRecovery = ({ app }: { app: string }) => {
  const core = useCore();
  const [submissions, setSubmissions] = useState<ScreenSubmission[]>([]);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) => await session.screenSubmissions.list(),
        left.signal
      );
      // Unreadable now is no reason to keep the App from its screen: the
      // submissions stay in core for the next time it opens.
      if (!left.signal.aborted && loaded.state === "ready") {
        setSubmissions(loaded.data.filter((each) => each.app === app));
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [app, core]);
  return (
    <SubmissionRecoveryView
      onDismissed={(id) => {
        setSubmissions((shown) => shown.filter((each) => each.id !== id));
      }}
      submissions={submissions}
    />
  );
};
