import { failureText } from "@grasp-os/shared/errors";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowDefinitionProblem,
  WorkflowDraft,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Label } from "@grasp-os/ui/components/label";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";

// A workflow's definition as its builders edit it: the draft's JSON, each
// save one revision-checked edit that core checks against the profile,
// what it found at its JSON Pointer and task, and publishing the latest
// edit once it passes. The page never decides what passes: core's answer
// does, and the editor keeps the person's text whatever it answers.

/** What the editor last heard of a save or publication. */
type Outcome =
  | { kind: "saved" }
  | { kind: "conflict" }
  | { kind: "published"; version: number }
  | { kind: "failed"; reason: string };

/** One problem core found, where it is, and what to change. */
const Problem = ({ problem }: { problem: WorkflowDefinitionProblem }) => (
  <li className="flex flex-col gap-1 border-b py-3 last:border-b-0">
    <div className="flex flex-wrap items-center gap-2">
      {problem.taskId === undefined ? null : (
        <Badge variant="outline">{problem.taskId}</Badge>
      )}
      <code className="text-muted-foreground text-xs">{problem.pointer}</code>
      <code className="text-muted-foreground text-xs">{problem.code}</code>
    </div>
    <p>{problem.message}</p>
    <p className="text-muted-foreground">{problem.remedy}</p>
  </li>
);

/** Where the latest edit stands, in words. */
const DraftStatus = ({ draft }: { draft: WorkflowDraft }) => {
  const { t } = useLingui();
  const { revision, problems, checkpoint } = draft;
  if (revision === 0) {
    return (
      <p className="text-muted-foreground">
        {checkpoint === null
          ? t`Nobody has edited it yet: it starts from a definition that passes.`
          : t`Nobody has edited it since its current version.`}
      </p>
    );
  }
  if (problems.length === 0) {
    return (
      <p className="text-muted-foreground">
        {t`Revision ${revision} passes the profile and can be published.`}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground">
      {checkpoint === null
        ? t`Revision ${revision} doesn't pass yet, and no revision has.`
        : t`Revision ${revision} doesn't pass yet. The latest that passed is revision ${checkpoint.revision}.`}
    </p>
  );
};

export const DefinitionEditor = ({
  workflow,
  loaded,
  currentVersion,
  onPublished,
  onVersionMoved,
}: {
  workflow: string;
  loaded: WorkflowDraft;
  currentVersion: number | null;
  onPublished: (version: WorkflowResourceVersion) => void;
  /** Someone published another version: the page reads the workflow again. */
  onVersionMoved: () => void;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const [draft, setDraft] = useState(loaded);
  const [text, setText] = useState(loaded.source);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const edited = text !== draft.source;
  const publishable =
    !edited &&
    draft.revision > 0 &&
    draft.problems.length === 0 &&
    draft.checkpoint?.revision === draft.revision;

  const save = async (): Promise<void> => {
    setBusy(true);
    setOutcome(undefined);
    try {
      const saved = await core.withSession(
        async (session) =>
          await session.workflowResources.editDraft(workflow, {
            expectedRevision: draft.revision,
            source: text,
          })
      );
      setDraft(saved);
      setOutcome({ kind: "saved" });
    } catch (error) {
      setOutcome(
        workflowResourceErrors.codeOf(error) === "workflow.draft_conflict"
          ? { kind: "conflict" }
          : { kind: "failed", reason: failureText(error) }
      );
    }
    setBusy(false);
  };

  // Someone else's edit landed first: theirs is read, and the person's own
  // text stays in the editor until they choose to take theirs.
  const reload = async (replace: boolean): Promise<void> => {
    setBusy(true);
    try {
      const latest = await core.withSession(
        async (session) => await session.workflowResources.draft(workflow)
      );
      setDraft(latest);
      if (replace) {
        setText(latest.source);
      }
      setOutcome(undefined);
    } catch (error) {
      setOutcome({ kind: "failed", reason: failureText(error) });
    }
    setBusy(false);
  };

  const publish = async (): Promise<void> => {
    setBusy(true);
    setOutcome(undefined);
    try {
      const version = await core.withSession(
        async (session) =>
          await session.workflowResources.publishDraft(workflow, {
            revision: draft.revision,
            basedOn: currentVersion,
          })
      );
      setOutcome({ kind: "published", version: version.version });
      onPublished(version);
    } catch (error) {
      setOutcome({ kind: "failed", reason: failureText(error) });
      // Built on a version no longer current: the page learns the current
      // one, keeping the person's text, so publishing again builds on it.
      if (
        workflowResourceErrors.codeOf(error) === "workflow.version_conflict"
      ) {
        onVersionMoved();
      }
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="workflow-definition">
          <Trans>workflow.json</Trans>
        </Label>
        <Textarea
          className="min-h-96"
          variant="code"
          id="workflow-definition"
          onChange={(event) => {
            setText(event.target.value);
          }}
          spellCheck={false}
          value={text}
        />
        <DraftStatus draft={draft} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy || !edited}
          onClick={() => {
            void save();
          }}
        >
          {busy ? t`Checking…` : t`Check and save`}
        </Button>
        <Button
          disabled={busy || !publishable}
          onClick={() => {
            void publish();
          }}
          variant="outline"
        >
          {t`Publish revision ${draft.revision}`}
        </Button>
        {edited ? (
          <span className="text-muted-foreground">
            <Trans>Unsaved changes</Trans>
          </span>
        ) : null}
      </div>
      {outcome?.kind === "conflict" ? (
        <Alert variant="destructive">
          <AlertDescription>
            <p>
              <Trans>
                Someone changed this draft since you read it. Your text is still
                here: read their revision, then save again, or take theirs
                instead.
              </Trans>
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() => {
                  void reload(false);
                }}
                size="sm"
                variant="outline"
              >
                <Trans>Keep my text</Trans>
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void reload(true);
                }}
                size="sm"
                variant="outline"
              >
                <Trans>Take theirs</Trans>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {outcome?.kind === "published" ? (
        <output>{t`Published as version ${outcome.version}.`}</output>
      ) : null}
      {outcome?.kind === "saved" ? (
        <output className="sr-only">
          {t`Saved as revision ${draft.revision}.`}
        </output>
      ) : null}
      <ErrorText>
        {outcome?.kind === "failed" ? outcome.reason : undefined}
      </ErrorText>
      {draft.problems.length === 0 ? null : (
        <section aria-labelledby="definition-problems">
          <h2 className="font-medium" id="definition-problems">
            <Trans>What to fix</Trans>
          </h2>
          <ul>
            {draft.problems.map((problem) => (
              <Problem
                key={`${problem.pointer} ${problem.code}`}
                problem={problem}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
