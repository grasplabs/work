import type { ChatProject, ProjectDocument } from "@grasp-os/shared/chat";
import {
  projectDocumentsMax,
  projectGoalMaxLength,
  projectNameSchema,
} from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { FilePlusIcon, FileTextIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { documentAccept, documentProblem } from "./chat-projects.ts";
import type { DocumentProblem } from "./chat-projects.ts";

// Making a project, or changing one (grasplabs/prototype
// `components/chat/project-dialog.tsx`): its name, what the person is
// trying to achieve, and the documents its chats' agent reads. Nothing is
// sent until Save; then core takes each change, and checks each again.

/** The longest name a project takes, as core checks it. */
const projectNameMaxLength = 100;

/** A document picked here, read as text, not yet sent. */
interface Picked {
  key: string;
  name: string;
  content: string;
}

/**
 * The files of `files` a project holding `count` documents can take, read
 * as text in the order picked, and why the first one it can't take
 * wasn't added.
 */
const readPicked = async (
  files: readonly File[],
  count: number
): Promise<{ read: Picked[]; first: DocumentProblem | null }> => {
  const taken: File[] = [];
  let first: DocumentProblem | null = null;
  for (const file of files) {
    const reason = documentProblem(file, count + taken.length);
    if (reason === null) {
      taken.push(file);
    } else {
      first ??= reason;
    }
  }
  const read = await Promise.all(
    taken.map(async (file) => ({
      key: crypto.randomUUID(),
      name: file.name,
      content: await file.text(),
    }))
  );
  return { read, first };
};

/** Why a picked file wasn't added: one a project can't take, or can't be read. */
type FormProblem = DocumentProblem | "unreadable";

/** The set without `key`. */
const withoutKey = (before: ReadonlySet<string>, key: string): Set<string> =>
  new Set([...before].filter((each) => each !== key));

/** Why a picked file wasn't added, as the person reads it. */
const useProblemText = (): Record<FormProblem, string> => {
  const { t } = useLingui();
  const most = projectDocumentsMax;
  return {
    type: t`A project takes Markdown, text, CSV and JSON files.`,
    size: t`Each document holds up to 100 KB.`,
    unreadable: t`A picked file couldn't be read. Pick it again.`,
    count: t`${plural(most, {
      one: "A project holds up to # document.",
      other: "A project holds up to # documents.",
    })}`,
  };
};

/**
 * The form, a fresh one for each opening: from the project as it is, or
 * empty for a new one. `onSaved` gets the project's ID once core has it.
 */
const ProjectForm = ({
  project,
  onSaved,
}: {
  project: ChatProject | undefined;
  onSaved: (projectId: string) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const problemText = useProblemText();
  const ids = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(project?.name ?? "");
  const [goal, setGoal] = useState(project?.goal ?? "");
  // What core holds, as far as this form knows: the project (none yet
  // for a new one), its name and goal, and its documents. A Save that
  // fails part-way leaves here what it got through, so trying again
  // takes up from there.
  const [held, setHeld] = useState<{
    id: string | undefined;
    name: string;
    goal: string;
  }>({
    id: project?.id,
    name: project?.name ?? "",
    goal: project?.goal ?? "",
  });
  const [documents, setDocuments] = useState<ProjectDocument[]>(
    project?.documents ?? []
  );
  // Documents core holds that the person took out, and files picked, not
  // yet sent.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [picked, setPicked] = useState<Picked[]>([]);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  // While picked files are read, or a Save runs: nothing changes.
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const locked = reading || saving;
  const named = projectNameSchema.safeParse(name).success;

  const add = async (files: readonly File[]): Promise<void> => {
    setReading(true);
    try {
      const { read, first } = await readPicked(
        files,
        documents.length - removing.size + picked.length
      );
      setPicked((before) => [...before, ...read]);
      setProblem(first);
    } catch {
      setProblem("unreadable");
    }
    setReading(false);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    const saved = await run(async (session) => {
      const trimmedName = name.trim();
      const trimmedGoal = goal.trim();
      let { id } = held;
      if (id === undefined) {
        const made = await session.chats.createProject(trimmedName);
        ({ id } = made);
        setHeld((before) => ({ ...before, id: made.id, name: made.name }));
      } else if (trimmedName !== held.name) {
        await session.chats.renameProject(id, trimmedName);
        setHeld((before) => ({ ...before, name: trimmedName }));
      }
      if (trimmedGoal !== held.goal) {
        await session.chats.setProjectGoal(id, trimmedGoal);
        setHeld((before) => ({ ...before, goal: trimmedGoal }));
      }
      for (const documentId of removing) {
        // oxlint-disable-next-line no-await-in-loop -- in order, so a failure leaves the rest as they were
        await session.chats.removeProjectDocument(id, documentId);
        setDocuments((before) =>
          before.filter((each) => each.id !== documentId)
        );
        setRemoving((before) => withoutKey(before, documentId));
      }
      for (const document of picked) {
        // oxlint-disable-next-line no-await-in-loop -- in order, so a failure leaves the rest as they were
        const added = await session.chats.addProjectDocument(id, {
          name: document.name,
          content: document.content,
        });
        // Sent: it is the project's now, and trying again doesn't send it twice.
        setPicked((before) =>
          before.filter((each) => each.key !== document.key)
        );
        setDocuments((before) => [...before, added]);
      }
      return id;
    });
    // Whatever went through shows, a refusal included.
    await router.invalidate();
    setSaving(false);
    if (saved !== undefined) {
      onSaved(saved);
    }
  };

  const listed = [
    ...documents
      .filter((document) => !removing.has(document.id))
      .map((document) => ({
        key: document.id,
        name: document.name,
        remove: () => {
          setRemoving((before) => new Set([...before, document.id]));
        },
      })),
    ...picked.map((document) => ({
      key: document.key,
      name: document.name,
      remove: () => {
        setPicked((before) =>
          before.filter((each) => each.key !== document.key)
        );
      },
    })),
  ];
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (named && !locked) {
          void save();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {project === undefined ? (
            <Trans>New project</Trans>
          ) : (
            <Trans>Edit project</Trans>
          )}
        </DialogTitle>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={`${ids}-name`}>
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          disabled={locked}
          // Not a login: password managers keep out of it.
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          id={`${ids}-name`}
          maxLength={projectNameMaxLength}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder={t`What are you working on?`}
          value={name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-goal`}>
          <Trans>Goal</Trans>
        </FieldLabel>
        <Textarea
          disabled={locked}
          id={`${ids}-goal`}
          maxLength={projectGoalMaxLength}
          onChange={(event) => {
            setGoal(event.target.value);
          }}
          placeholder={t`What are you trying to achieve?`}
          rows={3}
          value={goal}
        />
        <FieldDescription>
          <Trans>Every chat in this project reads it.</Trans>
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-documents`}>
          <Trans>Documents</Trans>
        </FieldLabel>
        <FieldDescription>
          <Trans>
            Every chat in this project reads them. Markdown, text, CSV or JSON,
            up to 100 KB each.
          </Trans>
        </FieldDescription>
        {listed.length === 0 ? null : (
          <ul
            aria-label={t`Documents in this project`}
            className="flex flex-col divide-y rounded-lg border"
          >
            {listed.map(({ key, name: documentName, remove }) => (
              <li
                className="flex items-center gap-2.5 py-1.5 pr-1.5 pl-3"
                key={key}
              >
                <FileTextIcon
                  aria-hidden="true"
                  className="text-muted-foreground size-4 flex-none"
                />
                <span className="min-w-0 flex-1 truncate">{documentName}</span>
                <Button
                  aria-label={t`Remove ${documentName}`}
                  disabled={locked}
                  onClick={() => {
                    remove();
                    setProblem(null);
                  }}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <input
          accept={documentAccept}
          className="sr-only"
          // Its label opens it too: closed while files are read or saved.
          disabled={locked}
          id={`${ids}-documents`}
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // Empty again, so the same file can be chosen once more.
            event.target.value = "";
            void add(files);
          }}
          ref={picker}
          tabIndex={-1}
          type="file"
        />
        <div className="flex">
          <Button
            disabled={locked}
            onClick={() => {
              picker.current?.click();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <FilePlusIcon data-icon="inline-start" />
            <Trans>Add documents</Trans>
          </Button>
        </div>
        {problem === null ? null : (
          <FieldError>{problemText[problem]}</FieldError>
        )}
      </Field>
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={saving}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={!named || locked} type="submit">
          {project === undefined ? (
            <Trans>Create project</Trans>
          ) : (
            <Trans>Save</Trans>
          )}
        </Button>
      </DialogFooter>
    </form>
  );
};

/**
 * Makes a project, or changes `project`: its name, goal and documents.
 * `onSaved` gets the project's ID, the dialog closing after it.
 */
export const ProjectDialog = ({
  open,
  project,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  /** The project being changed; without one, a new project is made. */
  project?: ChatProject;
  onOpenChange: (open: boolean) => void;
  onSaved?: (projectId: string) => void;
}) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent>
      {open ? (
        <ProjectForm
          key={project?.id ?? "new"}
          onSaved={(projectId) => {
            onSaved?.(projectId);
            onOpenChange(false);
          }}
          project={project}
        />
      ) : null}
    </DialogContent>
  </Dialog>
);
