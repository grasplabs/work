import {
  documentPathMaxLength,
  knowledgeErrors,
  linkPath,
} from "@grasp-os/shared/knowledge";
import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { FilePlusIcon } from "lucide-react";
import { useId, useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// A new document in a collection: the person names it, folders first if
// they like (`handbook/leave`), and core saves its first version, a heading
// with its name, to write on in the editor. A save at version 0 never
// overwrites: a document already at that path is a conflict.

/** The heading a new document starts with: its name, without folders. */
const titleOf = (name: string): string =>
  (name.split("/").at(-1) ?? name).replace(/\.md$/u, "").trim();

/**
 * Saves the new document, or says its path is taken already. Outside the
 * component, as the React Compiler can't compile `try`/`catch` around a
 * value it returns.
 */
const saveNew = async (
  session: Session,
  collectionId: string,
  path: string,
  title: string
): Promise<{ saved: DocumentSummary } | { taken: string }> => {
  try {
    const saved = await session.knowledge.saveDocument({
      collectionId,
      path,
      text: `# ${title}\n`,
      ifVersion: 0,
    });
    return { saved };
  } catch (error) {
    if (knowledgeErrors.codeOf(error) !== "knowledge.conflict") {
      throw error;
    }
  }
  return { taken: path };
};

/** Why the name can't be used: the collection has a document at `path`. */
const TakenPath = ({ path }: { path: string }) => (
  <FieldError>
    <Trans>This collection has a document at {path} already.</Trans>
  </FieldError>
);

const DocumentForm = ({ collectionId }: { collectionId: string }) => {
  const { t } = useLingui();
  const ids = useId();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const [name, setName] = useState("");
  const [taken, setTaken] = useState<string>();
  const trimmed = name.trim();
  const path = trimmed === "" ? undefined : linkPath(trimmed);
  const invalid = trimmed !== "" && path === undefined;

  const create = async (at: string): Promise<void> => {
    setTaken(undefined);
    const outcome = await run(
      async (session) =>
        await saveNew(session, collectionId, at, titleOf(trimmed))
    );
    // Undefined when core refused, as `failure` then says.
    if (outcome === undefined) {
      return;
    }
    if ("taken" in outcome) {
      setTaken(outcome.taken);
      return;
    }
    await navigate({
      to: "/knowledge/$collection",
      params: { collection: collectionId },
      search: { doc: outcome.saved.id },
    });
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (path !== undefined && !busy) {
          void create(path);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>New document</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            It starts with its name as a heading; write the rest in the editor.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <Field data-invalid={invalid || taken !== undefined}>
        <FieldLabel htmlFor={`${ids}-name`}>
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          aria-invalid={invalid || taken !== undefined}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          disabled={busy}
          id={`${ids}-name`}
          maxLength={documentPathMaxLength}
          onChange={(event) => {
            setName(event.target.value);
            setTaken(undefined);
          }}
          placeholder={t`handbook/leave`}
          value={name}
        />
        <FieldDescription>
          <Trans>Put it in folders with a slash, as in handbook/leave.</Trans>
        </FieldDescription>
        {invalid ? (
          <FieldError>
            <Trans>A name has no [, ], # or |, and no empty folders.</Trans>
          </FieldError>
        ) : null}
        {taken === undefined ? null : <TakenPath path={taken} />}
      </Field>
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={busy}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={path === undefined || busy} type="submit">
          <Trans>Create document</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
};

/** "New document" in a collection the person may change, opening the form. */
export const NewDocument = ({ collectionId }: { collectionId: string }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <FilePlusIcon data-icon="inline-start" />
        <Trans>New document</Trans>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        {open ? <DocumentForm collectionId={collectionId} /> : null}
      </DialogContent>
    </Dialog>
  );
};
