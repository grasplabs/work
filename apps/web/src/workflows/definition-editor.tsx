import { draftErrors } from "@grasp-os/shared/drafts";
import { failureText } from "@grasp-os/shared/errors";
import type {
  WorkflowDefinitionProblem,
  WorkflowDraft,
} from "@grasp-os/shared/workflow-resources";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";
import { SectionCard } from "./section-card.tsx";

// A workflow's definition as its builders edit it: the draft's JSON
// (`workflow.json`, the draft every builder shares), each save one
// revision-checked edit that core checks against the profile, and what
// it found at its JSON Pointer and task. The page never decides what
// passes: core's answer does, and the editor keeps the person's text
// whatever it answers. What passes is drawn on the page's Flow, where a
// step changed (`define`) comes back here as the draft's newer
// revision. Sharing it with the team is the bar's (Share with your team).

/** How many lines the definition's field shows before its text scrolls. */
const DEFINITION_ROWS = 24;

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: space["4"] },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  unsaved: {
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  conflict: { display: "flex", flexDirection: "column", gap: space["2"] },
  where: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
});

/** What the editor last heard of a save. */
type Outcome =
  | { kind: "saved" }
  | { kind: "conflict" }
  | { kind: "failed"; reason: string };

/** One problem core found, where it is, and what to change. */
const Problem = ({ problem }: { problem: WorkflowDefinitionProblem }) => (
  <Item size="sm">
    <ItemContent>
      <ItemTitle>{problem.message}</ItemTitle>
      <ItemDescription>{problem.remedy}</ItemDescription>
      <span {...stylex.props(styles.where)}>
        {problem.taskId === undefined ? null : (
          <Badge size="sm">{problem.taskId}</Badge>
        )}
        <ItemDetail>
          <code>{problem.pointer}</code>
        </ItemDetail>
        <ItemDetail>
          <code>{problem.code}</code>
        </ItemDetail>
      </span>
    </ItemContent>
  </Item>
);

/** Whether the draft passes, in words. */
const DraftStatus = ({ draft }: { draft: WorkflowDraft }) => {
  const { t } = useLingui();
  return draft.problems.length === 0
    ? t`It passes its checks.`
    : t`It doesn't pass yet: what to fix is below.`;
};

/** What core found in the latest revision, when it found anything. */
const Problems = ({
  problems,
}: {
  problems: readonly WorkflowDefinitionProblem[];
}) => {
  const { t } = useLingui();
  return problems.length === 0 ? null : (
    <SectionCard flush title={t`What to fix`}>
      <ItemGroup separated>
        {problems.map((problem) => (
          <Problem
            key={`${problem.pointer} ${problem.code} ${problem.message}`}
            problem={problem}
          />
        ))}
      </ItemGroup>
    </SectionCard>
  );
};

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
    <>
      <SectionCard aria-label={t`Definition`}>
        <div {...stylex.props(styles.body)}>
          <Field>
            <FieldLabel>{t`workflow.json`}</FieldLabel>
            <Textarea
              autoResize={false}
              onValueChange={setText}
              readOnly={replacing}
              rows={DEFINITION_ROWS}
              spellCheck={false}
              value={text}
            />
            <FieldDescription>
              <DraftStatus draft={draft} />
            </FieldDescription>
          </Field>
          <div {...stylex.props(styles.actions)}>
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
              <span {...stylex.props(styles.unsaved)}>
                {t`Unsaved changes`}
              </span>
            ) : null}
          </div>
          {outcome?.kind === "conflict" ? (
            <div {...stylex.props(styles.conflict)}>
              <Alert variant="destructive">
                <AlertDescription>
                  {t`Someone changed this draft since you read it. Your text is still here: read their revision, then save again, or take theirs instead.`}
                </AlertDescription>
              </Alert>
              <div {...stylex.props(styles.actions)}>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void reload(false);
                  }}
                  size="sm"
                  variant="outline"
                >
                  {t`Keep my text`}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void reload(true);
                  }}
                  size="sm"
                  variant="outline"
                >
                  {t`Take theirs`}
                </Button>
              </div>
            </div>
          ) : null}
          {outcome?.kind === "saved" ? (
            <output {...stylex.props(visuallyHidden)}>{t`Saved.`}</output>
          ) : null}
          <ErrorText>
            {outcome?.kind === "failed" ? outcome.reason : undefined}
          </ErrorText>
        </div>
      </SectionCard>
      <Problems problems={draft.problems} />
    </>
  );
};
