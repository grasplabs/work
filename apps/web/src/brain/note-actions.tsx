import type { Workspace } from "@grasp-os/shared/brain";
import { Button } from "@grasp-os/ui/components/button";
import { DropdownMenuMore } from "@grasp-os/ui/components/dropdown-menu";
import type { DropdownMenuMoreItem } from "@grasp-os/ui/components/dropdown-menu";
import { toast } from "@grasp-os/ui/components/toast";
import {
  BrainIcon,
  FileDocIcon,
  FilePdfIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";

import { copyText } from "../copy.ts";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFormat } from "../export/export-file.tsx";
import { noteFileName, noteMarkdown } from "./brain-markdown.ts";
import type { Note } from "./brain.ts";
import { useCanForget, useForget } from "./forget.tsx";
import { GapActions } from "./gap-actions.tsx";

// A note's actions at the end of the page's bar, as the library's Brain page
// has them (Ruben's pick D): Share, then "…" with Download, View in map and,
// for whoever may, Remove from the brain. Share copies the page's link: a
// note has no audience of its own to choose yet (core need 47), so the link
// is all there is to give. History joins "…" once core keeps a note's
// versions. A question's own page keeps its admin's two actions beside them.

export const NoteActions = ({
  note,
  workspace,
}: {
  note: Note;
  workspace: Workspace;
}) => {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const canForget = useCanForget();
  // Once a source is gone its page is too: back to the brain.
  const forget = useForget(() => {
    void navigate({ to: "/brain" });
  });
  const source = workspace.sources.find(
    (candidate) => candidate.id === note.id
  );
  const { title } = note;
  const download = async (format: ExportFormat): Promise<void> => {
    try {
      await exportAs(
        {
          name: noteFileName(note),
          title,
          markdown: () =>
            noteMarkdown(note, {
              baseUrl: window.location.origin,
              exportedOn: new Date().toISOString().slice(0, 10),
            }),
        },
        format,
        i18n.locale
      );
    } catch {
      toast.error(t`The export didn't work. Try again.`);
    }
  };
  const actions: DropdownMenuMoreItem[] = [
    {
      label: t`Download as Markdown`,
      icon: FileDocIcon,
      onSelect: () => {
        void download("md");
      },
    },
    {
      label: t`Download as PDF`,
      icon: FilePdfIcon,
      onSelect: () => {
        void download("pdf");
      },
    },
    {
      label: t`View in map`,
      icon: BrainIcon,
      // The company is the whole brain.
      render: (
        <Link
          search={note.kind === "company" ? {} : { note: note.id }}
          to="/brain"
        />
      ),
    },
    ...(canForget && source?.forgettable === true
      ? [
          {
            label: t`Remove from the brain`,
            icon: TrashIcon,
            variant: "destructive" as const,
            onSelect: () => {
              forget.ask({ source: note.id }, title);
            },
          },
        ]
      : []),
  ];
  return (
    <>
      {note.kind === "gap" ? <GapActions noteId={note.id} /> : null}
      <Button
        onClick={() => {
          void (async () => {
            if (await copyText(window.location.href)) {
              toast.success(t`Link copied`);
            } else {
              toast.error(t`Copying didn't work`);
            }
          })();
        }}
        size="sm"
        variant="ghost"
      >
        {t({ message: "Share", context: "a Brain page's link" })}
      </Button>
      <DropdownMenuMore aria-label={t`More for this page`} items={actions} />
      {forget.element}
    </>
  );
};
