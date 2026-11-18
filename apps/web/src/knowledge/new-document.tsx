import {
  documentPathMaxLength,
  knowledgeErrors,
  linkPath,
} from "@grasp-os/shared/knowledge";
import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { File as FileMark } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
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
  <FieldError match>
    <Trans>This collection has a document at {path} already.</Trans>
  </FieldError>
);

const DocumentForm = ({
  collectionId,
  onCreated,
}: {
  collectionId: string;
  /** Closes the dialog: the collection's page, and it, stay mounted. */
  onCreated: () => void;
}) => {
  const { t } = useLingui();
  const formId = useId();
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
    onCreated();
    await navigate({
      to: "/knowledge/$collection",
      params: { collection: collectionId },
      search: { doc: outcome.saved.id },
    });
  };

  return (
    <>
      <DialogBody>
        <Form
          aria-label={t`New document`}
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (path !== undefined && !busy) {
              void create(path);
            }
          }}
        >
          <Field invalid={invalid || taken !== undefined}>
            <FieldLabel>{t`Name`}</FieldLabel>
            <Input
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              disabled={busy}
              maxLength={documentPathMaxLength}
              onValueChange={(value) => {
                setName(value);
                setTaken(undefined);
              }}
              placeholder={t`handbook/leave`}
              value={name}
            />
            <FieldDescription>
              {t`Put it in folders with a slash, as in handbook/leave.`}
            </FieldDescription>
            {invalid ? (
              <FieldError match>
                {t`A name has no [, ], # or |, and no empty folders.`}
              </FieldError>
            ) : null}
            {taken === undefined ? null : <TakenPath path={taken} />}
          </Field>
          <ErrorText>{failure}</ErrorText>
        </Form>
      </DialogBody>
      <DialogFooter>
        <DialogAction disabled={busy}>{t`Cancel`}</DialogAction>
        <Button
          disabled={path === undefined || busy}
          form={formId}
          size="sm"
          type="submit"
          variant="ink"
        >
          {t`Create document`}
        </Button>
      </DialogFooter>
    </>
  );
};

/** "New document" in a collection the person may change, opening the form. */
export const NewDocument = ({ collectionId }: { collectionId: string }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger icon={FileMark} size="sm">
        {t`New document`}
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`New document`}</DialogTitle>
        {open ? (
          <DocumentForm
            collectionId={collectionId}
            onCreated={() => {
              setOpen(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
