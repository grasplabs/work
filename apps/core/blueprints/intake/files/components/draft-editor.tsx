import { useMutation } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useState } from "react";

import { api } from "#grasp";

import {
  draftProblem,
  emptyDraft,
  mediumLabels,
  notesMax,
  refusal,
  settle,
  shortTextMax,
  sourceMedia,
} from "./intake";
import type {
  Draft,
  DraftSource,
  OpenedDraft,
  Outcome,
  SourceMedium,
} from "./intake";
import { whilePending } from "./pending";
import { StatementsEditor } from "./statements";

const media = sourceMedia.map((value) => ({
  value,
  label: mediumLabels[value],
}));

/** The source: its title, medium, date, who it came from, and its notes. */
export const SourceFields = ({
  source,
  disabled,
  onChange,
}: {
  source: DraftSource;
  disabled: boolean;
  onChange: (source: DraftSource) => void;
}) => (
  <div className="flex flex-col gap-2">
    <Input
      aria-label="Source title"
      placeholder="Interview with the controller"
      maxLength={shortTextMax}
      value={source.title}
      disabled={disabled}
      onChange={(event) => {
        onChange({ ...source, title: event.target.value });
      }}
    />
    <div className="flex flex-wrap gap-2">
      <Select
        items={media}
        value={source.medium}
        disabled={disabled}
        onValueChange={(medium: SourceMedium | null) => {
          onChange({ ...source, medium: medium ?? source.medium });
        }}
      >
        <SelectTrigger aria-label="Medium">
          <SelectValue placeholder="Medium" />
        </SelectTrigger>
        <SelectContent>
          {media.map((medium) => (
            <SelectItem key={medium.value} value={medium.value}>
              {medium.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        aria-label="Date"
        type="date"
        className="w-auto"
        value={source.date}
        disabled={disabled}
        onChange={(event) => {
          onChange({ ...source, date: event.target.value });
        }}
      />
      <Input
        aria-label="From"
        placeholder="Who it came from: a name or a role"
        className="w-auto grow"
        maxLength={shortTextMax}
        value={source.from}
        disabled={disabled}
        onChange={(event) => {
          onChange({ ...source, from: event.target.value });
        }}
      />
    </div>
    <Textarea
      aria-label="Notes"
      placeholder="The notes, kept with the source (optional)"
      maxLength={notesMax}
      value={source.notes}
      disabled={disabled}
      onChange={(event) => {
        onChange({ ...source, notes: event.target.value });
      }}
    />
  </div>
);

/** What a save answers: the source saved, and how many statements. */
export interface Saved {
  source: string;
  statements: number;
}

/** What an action ends in, for the screen that holds the editor. */
export type EditorResult =
  /** Kept, at its new revision; `problem` when saving it then failed. */
  | { kind: "kept"; opened: OpenedDraft; problem?: string }
  | { kind: "saved"; saved: Saved }
  | { kind: "discarded" };

/**
 * A draft, reviewed and edited before it is saved: a new one (`opened`
 * null) or one kept earlier. Saving writes its source and statements and
 * drops the draft, in one commit; keeping stores the edits for later;
 * discarding drops it. Each sends the revision it was opened at, so
 * nobody's edits are written over (`data.conflict`). Nothing can be
 * edited while an action is on its way, so none is lost when it ends.
 */
export const DraftEditor = ({
  opened,
  problem: shownFirst,
  onResult,
  onBack,
}: {
  opened: OpenedDraft | null;
  /** Why the last action on it failed, shown until the next one. */
  problem: string;
  onResult: (result: EditorResult) => void;
  onBack: () => void;
}) => {
  const [draft, setDraft] = useState<Draft>(opened?.draft ?? emptyDraft());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(shownFirst);
  const create = useMutation(api.drafts.create);
  const keepDraft = useMutation(api.drafts.keep);
  const saveDraft = useMutation(api.drafts.save);
  const discardDraft = useMutation(api.drafts.discard);
  const invalid = draftProblem(draft);

  /** Runs `act`, showing why it was refused, if it was. */
  const run = async <T,>(
    act: () => Promise<Outcome<T>>,
    then: (value: T) => Promise<void> | void
  ): Promise<void> => {
    const answer = await whilePending(setBusy, act);
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setProblem("");
    await then(answer.ok);
  };

  const keep = async (): Promise<void> => {
    if (opened === null) {
      await run(
        async () => await settle(async () => await create(draft)),
        (id) => {
          onResult({
            kind: "kept",
            opened: { id, revision: 1, origin: "manual", draft },
          });
        }
      );
      return;
    }
    await run(
      async () =>
        await settle(
          async () =>
            await keepDraft({
              id: opened.id,
              expectedRevision: opened.revision,
              ...draft,
            })
        ),
      (revision) => {
        onResult({ kind: "kept", opened: { ...opened, revision, draft } });
      }
    );
  };

  const save = async (): Promise<void> => {
    if (opened !== null) {
      await run(
        async () =>
          await settle(
            async () =>
              await saveDraft({
                id: opened.id,
                expectedRevision: opened.revision,
                ...draft,
              })
          ),
        (saved) => {
          onResult({ kind: "saved", saved });
        }
      );
      return;
    }
    // A new draft is kept first. Should saving it fail, it is open as
    // kept, saying why, so saving again saves that one, never another.
    await run(
      async () => await settle(async () => await create(draft)),
      async (id) => {
        const kept: OpenedDraft = { id, revision: 1, origin: "manual", draft };
        const answer = await whilePending(
          setBusy,
          async () =>
            await settle(
              async () => await saveDraft({ id, expectedRevision: 1, ...draft })
            )
        );
        if ("error" in answer) {
          onResult({
            kind: "kept",
            opened: kept,
            problem: refusal(answer.error),
          });
          return;
        }
        onResult({ kind: "saved", saved: answer.ok });
      }
    );
  };

  const discard = async (): Promise<void> => {
    if (opened === null) {
      onBack();
      return;
    }
    await run(
      async () =>
        await settle(
          async () =>
            await discardDraft({
              id: opened.id,
              expectedRevision: opened.revision,
            })
        ),
      () => {
        onResult({ kind: "discarded" });
      }
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{opened === null ? "New source" : "Review"}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {opened?.origin === "guest" ? (
            <p className="text-sm">
              Taken out of what a stakeholder wrote in a chat by link: their
              words, not checked by anyone yet. Check each statement against the
              notes, and clear from the notes anything that shouldn&apos;t be
              kept: they are saved as the source&apos;s text.
            </p>
          ) : null}
          <SourceFields
            source={draft.source}
            disabled={busy}
            onChange={(source) => {
              setDraft({ ...draft, source });
            }}
          />
          <StatementsEditor
            statements={draft.statements}
            disabled={busy}
            onChange={(statements) => {
              setDraft({ ...draft, statements });
            }}
          />
          {problem === "" ? null : (
            <p role="alert" className="text-destructive text-sm">
              {problem}
            </p>
          )}
          {invalid === undefined ? null : (
            <p className="text-muted-foreground text-sm">{invalid}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy || invalid !== undefined || draft.statements.length === 0
              }
              onClick={() => {
                void save();
              }}
            >
              Save
            </Button>
            <Button
              variant="outline"
              disabled={busy || invalid !== undefined}
              onClick={() => {
                void keep();
              }}
            >
              Keep as a draft
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void discard();
              }}
            >
              Discard
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onBack}>
              Back
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
