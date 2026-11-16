import type {
  InstructionFileRef,
  InstructionFileText,
} from "@grasp-os/shared/instruction-files";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// An instruction file, as someone who may change it edits it: what every
// chat it applies to starts with (core's instruction-files.ts). Saved
// whole as the file's next version when they press Save, after the
// version they started from, so it never overwrites a save they didn't
// see; the one before stays as its history. Emptied, it loads nowhere. Core decides who may read and save each file; a
// page shows one only to those core lets read it.

export const InstructionFileEditor = ({
  file,
  saved,
  label,
  description,
  onSaved,
}: {
  file: InstructionFileRef;
  /** The file as it is now; null while it was never written. */
  saved: InstructionFileText | null;
  label: string;
  description: string;
  /** What else a save asks of core, once it landed and before the page is read again. */
  onSaved?: (session: Session) => Promise<void>;
}) => {
  const { t } = useLingui();
  const changedSince = t`Someone saved this file since you started. Put your changes aside to see their version, then make yours again.`;
  const id = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  // What they typed, and the version they started from: saved only after
  // that version, so a save never overwrites one they didn't see.
  const [draft, setDraft] = useState<{ text: string; from: number }>();
  // The last save tried, by the change that names it, its text and the
  // version it started from: the same text from the same version again
  // (one whose answer was lost) names the same change, so core saves it
  // once; any other text, a save from another version, or any save after
  // one went through, is a change of its own.
  const [tried, setTried] = useState<{
    change: string;
    text: string;
    after: number;
  }>();
  const savedText = saved?.text ?? "";
  // A save the page now shows landed (its text, past the version it
  // started from) is done: its change is never sent again.
  const landed =
    tried !== undefined &&
    saved !== null &&
    saved.text === tried.text &&
    saved.version > tried.after;
  const text = draft?.text ?? savedText;
  const unchanged = draft === undefined || draft.text === savedText;
  // Someone saved since they started typing: theirs is shown only once
  // these changes are put aside.
  // A draft that matches what is saved (their own save, its answer lost)
  // is no conflict: they start again from that version.
  const stale = !unchanged && draft.from !== (saved?.version ?? 0);
  // Emptying a file is a save; saving an empty file again isn't.
  const nothing = text.trim() === "" && savedText.trim() === "";
  const save = (): void => {
    if (draft === undefined) {
      return;
    }
    const sent = text.trim() === "" ? "" : text;
    const change =
      tried !== undefined &&
      !landed &&
      tried.text === sent &&
      tried.after === draft.from
        ? tried.change
        : crypto.randomUUID();
    setTried({ change, text: sent, after: draft.from });
    void run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.instructions.save({
            file,
            change,
            text: sent,
            after: draft.from,
          });
          setDraft(undefined);
          setTried(undefined);
          await onSaved?.(session);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
      <Textarea
        disabled={busy}
        id={id}
        onChange={(event) => {
          setDraft({
            text: event.target.value,
            from: unchanged ? (saved?.version ?? 0) : draft.from,
          });
        }}
        rows={8}
        value={text}
      />
      {stale ? (
        <ErrorText>{changedSince}</ErrorText>
      ) : (
        <ErrorText>{failure}</ErrorText>
      )}
      <div className="flex justify-end gap-2">
        {stale ? (
          <Button
            disabled={busy}
            onClick={() => {
              setDraft(undefined);
              setTried(undefined);
            }}
            variant="outline"
          >
            <Trans>Put my changes aside</Trans>
          </Button>
        ) : null}
        <Button disabled={busy || unchanged || stale || nothing} onClick={save}>
          <Trans>Save</Trans>
        </Button>
      </div>
    </Field>
  );
};
