import { draftErrors } from "@grasp-os/shared/drafts";
import { failureText } from "@grasp-os/shared/errors";
import type {
  WorkflowDefinitionProblem,
  WorkflowDraft,
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

// A workflow's definition as its builders edit it: the draft's JSON
// (`workflow.json`, the draft every builder shares), each save one
// revision-checked edit that core checks against the profile, and what
// it found at its JSON Pointer and task. The page never decides what
// passes: core's answer does, and the editor keeps the person's text
// whatever it answers. What passes is drawn on the page's Flow, where a
// step changed (`define`) comes back here as the draft's newer
// revision. Sharing it with the team is the bar's (Share with your team).

/** What the editor last heard of a save. */
type Outcome =
  | { kind: "saved" }
  | { kind: "conflict" }
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

/** Whether the draft passes, in words. */
const DraftStatus = ({ draft }: { draft: WorkflowDraft }) => (
  <p className="text-muted-foreground">
    {draft.problems.length === 0 ? (
      <Trans>It passes its checks.</Trans>
    ) : (
      <Trans>It doesn&apos;t pass yet: what to fix is below.</Trans>
    )}
  </p>
);

/** What core found in the latest revision, when it found anything. */
const Problems = ({
  problems,
}: {
  problems: readonly WorkflowDefinitionProblem[];
}) =>
  problems.length === 0 ? null : (
    <section aria-labelledby="definition-problems">
      <h2 className="font-medium" id="definition-problems">
        <Trans>What to fix</Trans>
      </h2>
      <ul>
        {problems.map((problem) => (
          <Problem
            key={`${problem.pointer} ${problem.code} ${problem.message}`}
            problem={problem}
          />
        ))}
      </ul>
    </section>
  );

/**
 * The draft the editor goes by, and the text in it, from
 * `loaded`; and whether they were edited since. A later revision the page
 * has (a step changed on the Flow) is taken, text and all, unless
 * something typed here would be lost: then saving meets it as a conflict,
 * as it would anyone else's save.
 */
const useEdited = (loaded: WorkflowDraft) => {
  const [draft, setDraft] = useState(loaded);
  const [text, setText] = useState(loaded.source);
  const edited = text !== draft.source;
  const [seen, setSeen] = useState(loaded);
  if (loaded !== seen) {
    setSeen(loaded);
    if (loaded.revision > draft.revision && !edited) {
      setDraft(loaded);
      setText(loaded.source);
    }
  }
  return { draft, setDraft, text, setText, edited };
};

export const DefinitionEditor = ({
  workflow,
  loaded,
  onDraft,
}: {
  workflow: string;
  /**
   * The draft as the page last had it, read or saved; a later revision
   * saved elsewhere on the page (a step changed on the Flow) is taken
   * here while nothing is typed that it would overwrite.
   */
  loaded: WorkflowDraft;
  /** The draft as a save or a read here left it. */
  onDraft: (draft: WorkflowDraft) => void;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const { draft, setDraft, text, setText, edited } = useEdited(loaded);
  // What a save or a read here left, here and on the page around it.
  const took = (next: WorkflowDraft): void => {
    setDraft(next);
    onDraft(next);
  };
  const [busy, setBusy] = useState(false);
  // Taking theirs replaces the text when it arrives: the editor holds still
  // until then, so nothing typed meanwhile is overwritten.
  const [replacing, setReplacing] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  const save = async (): Promise<void> => {
    setBusy(true);
    setOutcome(undefined);
    try {
      const saved = await core.withSession(async (session) => {
        await session.drafts.write(
          { kind: "workflow", id: workflow },
          draft.revision,
          { "workflow.json": text }
        );
        // What core found in it, at the revision saved or a later one.
        return await session.workflowResources.draft(workflow);
      });
      took(saved);
      setOutcome({ kind: "saved" });
    } catch (error) {
      setOutcome(
        draftErrors.codeOf(error) === "draft.conflict"
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
    setReplacing(replace);
    try {
      const latest = await core.withSession(
        async (session) => await session.workflowResources.draft(workflow)
      );
      took(latest);
      if (replace) {
        setText(latest.source);
      }
      setOutcome(undefined);
    } catch (error) {
      setOutcome({ kind: "failed", reason: failureText(error) });
    }
    setReplacing(false);
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
          readOnly={replacing}
          spellCheck={false}
          value={text}
        />
        <DraftStatus draft={draft} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          // The definition it starts from is saved as it is, too, as the
          // draft's first change, to check.
          disabled={busy || (!edited && draft.revision > 0)}
          onClick={() => {
            void save();
          }}
        >
          {busy ? t`Checking…` : t`Check and save`}
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
      {outcome?.kind === "saved" ? (
        <output className="sr-only">{t`Saved.`}</output>
      ) : null}
      <ErrorText>
        {outcome?.kind === "failed" ? outcome.reason : undefined}
      </ErrorText>
      <Problems problems={draft.problems} />
    </div>
  );
};
