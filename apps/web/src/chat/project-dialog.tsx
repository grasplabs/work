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

/** Why a picked file wasn't added, as the person reads it. */
const useProblemText = (): Record<DocumentProblem, string> => {
  const { t } = useLingui();
  const most = projectDocumentsMax;
  return {
    type: t`A project takes Markdown, text, CSV and JSON files.`,
    size: t`Each document holds up to 100 KB.`,
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
  const { busy, failure, run } = useCoreAction();
  const problemText = useProblemText();
  const ids = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(project?.name ?? "");
  const [goal, setGoal] = useState(project?.goal ?? "");
  const [kept, setKept] = useState<ProjectDocument[]>(project?.documents ?? []);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [problem, setProblem] = useState<DocumentProblem | null>(null);
  const named = projectNameSchema.safeParse(name).success;

  // While picked files are read: nothing more is picked, and nothing is
  // saved, until they are in the list.
  const [reading, setReading] = useState(false);
  const add = async (files: readonly File[]): Promise<void> => {
    setReading(true);
    const { read, first } = await readPicked(
      files,
      kept.length + picked.length
    );
    setPicked((before) => [...before, ...read]);
    setProblem(first);
    setReading(false);
  };

  // What a Save that failed part-way got through, so trying again takes
  // up from there: the project it made, and the documents it removed.
  const created = useRef<string | null>(null);
  const removed = useRef(new Set<string>());
  const save = async (): Promise<void> => {
    const saved = await run(async (session) => {
      const trimmedName = name.trim();
      const trimmedGoal = goal.trim();
      let id = project?.id ?? created.current ?? undefined;
      if (id === undefined) {
        ({ id } = await session.chats.createProject(trimmedName));
        created.current = id;
      } else if (trimmedName !== (project?.name ?? trimmedName)) {
        await session.chats.renameProject(id, trimmedName);
      }
      if (trimmedGoal !== (project?.goal ?? "")) {
        await session.chats.setProjectGoal(id, trimmedGoal);
      }
      const keptIds = new Set(kept.map((document) => document.id));
      for (const document of project?.documents ?? []) {
        if (!keptIds.has(document.id) && !removed.current.has(document.id)) {
          // oxlint-disable-next-line no-await-in-loop -- in order, so a failure leaves the rest as they were
          await session.chats.removeProjectDocument(id, document.id);
          removed.current.add(document.id);
        }
      }
      for (const document of picked) {
        // oxlint-disable-next-line no-await-in-loop -- in order, so a failure leaves the rest as they were
        await session.chats.addProjectDocument(id, {
          name: document.name,
          content: document.content,
        });
        // Sent: trying again doesn't send it twice.
        setPicked((before) =>
          before.filter((each) => each.key !== document.key)
        );
      }
      return id;
    });
    // Whatever went through shows, a refusal included.
    await router.invalidate();
    if (saved !== undefined) {
      onSaved(saved);
    }
  };

  const documents = [
    ...kept.map((document) => ({
      key: document.id,
      name: document.name,
      remove: () => {
        setKept((before) => before.filter((each) => each.id !== document.id));
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
        if (named && !busy && !reading) {
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
        {documents.length === 0 ? null : (
          <ul
            aria-label={t`Documents in this project`}
            className="flex flex-col divide-y rounded-lg border"
          >
            {documents.map(({ key, name: documentName, remove }) => (
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
            disabled={reading}
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
        <DialogClose render={<Button type="button" variant="outline" />}>
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={!named || busy || reading} type="submit">
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
