import { agentErrors } from "@grasp-os/shared/agent";
import type { Agent, AgentDocument } from "@grasp-os/shared/agents";
import {
  chatFileMaxBytes,
  chatFileTypeOf,
  chatFileTypes,
} from "@grasp-os/shared/chat";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@grasp-os/ui/components/empty";
import { FileUpload } from "@grasp-os/ui/components/file-upload";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Icon, FileIcon, TrashIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { Session } from "../core.ts";
import { formatBytes } from "../format.ts";
import { useHeldDialog } from "../workflows/held-dialog.ts";
import { SeparatedItems } from "../workflows/separated-items.tsx";
import { SectionCard } from "./section-card.tsx";

// An agent's documents, on its page's Instructions part (agent-page.tsx):
// files an admin gives it to answer from, such as a checklist or a policy
// too long for its instructions. Core reads each file's text once and
// keeps only that (agent-documents.ts); the agent is told its documents
// by name and reads one when a question needs it. Whoever may ask the
// agent may learn what a document says, and the card says so where one
// is added (behind the card's info mark). A card of Grasp UI's Items under
// File upload's drop zone, with a line on what to give it and why: each
// file is sent to core as it is dropped or chosen, said on its row in the
// zone, and once core keeps it, it is a document's row.

/** What a page change asks of core, then the page read again. */
/**
 * A change asked of core, then the page read again; whether it was made.
 * Why it wasn't goes under the page's header, or to `report` (a dialog's
 * own line, where the person is looking).
 */
type Change = (
  action: (session: Session) => Promise<unknown>,
  report?: (why: string) => void
) => Promise<boolean>;

const styles = stylex.create({
  // The drop zone, inset in the flush card above the documents.
  zone: { padding: space["3"] },
});

/** The kinds of file core takes, by their extensions. */
const accepted = Object.keys(chatFileTypes).map((extension) => `.${extension}`);

/**
 * Remove, behind a question: a removed document can't be put back without
 * its file. Held open while it is removed; when that fails, the button says
 * so and the question stays.
 */
const RemoveDocument = ({
  file,
  can,
  remove,
}: {
  file: string;
  can: boolean;
  remove: () => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const dialog = useHeldDialog();
  return (
    <AlertDialog onOpenChange={dialog.handleOpenChange} open={dialog.open}>
      <AlertDialogTrigger asChild>
        <Button
          aria-label={t`Remove ${file}`}
          disabled={!can}
          size="icon-sm"
          variant="ghost"
        >
          <Icon icon={TrashIcon} />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Remove ${file}?`}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            errorText={t`Couldn't remove`}
            onClick={async () => {
              await dialog.hold(async () => {
                if (!(await remove())) {
                  throw new Error("The document wasn't removed.");
                }
              });
            }}
            variant="destructive"
          >
            {t`Remove`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** The rows of `agent`'s documents, and the place to add more. */
export const AgentDocuments = ({
  agent,
  documents,
  editable,
  can,
  change,
}: {
  agent: Agent;
  /** Its documents, the oldest first; undefined where core didn't say. */
  documents: readonly AgentDocument[] | undefined;
  /** Whether the person may change documents at all. */
  editable: boolean;
  /** Whether they may now: not while a change is on its way to core. */
  can: boolean;
  change: Change;
}) => {
  const { t, i18n } = useLingui();
  const { name } = agent;
  // The files on their way or refused; one core kept leaves the list, as
  // it is a document's row now, and the others keep theirs.
  const [files, setFiles] = useState<File[]>([]);
  const added = (at: string): string =>
    new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
      new Date(at)
    );
  // One file to core. It throws when core didn't take it, so File upload
  // says so on the file's row; why is said under the page's header.
  const send = async (file: File): Promise<void> => {
    const sent = await change(async (session) => {
      // Refused here as core would, before it is sent at all: a file past
      // what one message to core holds would drop the connection, and
      // every call waiting on it, before core could say why.
      if (chatFileTypeOf(file.name) === undefined) {
        throw agentErrors.create("agent.document_unsupported");
      }
      if (file.size > chatFileMaxBytes) {
        throw agentErrors.create("agent.document_too_large");
      }
      await session.connections.addAgentDocument(agent.id, {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    });
    if (!sent) {
      throw new Error(t`Not added`);
    }
    setFiles((current) => current.filter((each) => each !== file));
  };
  const editing = editable && documents !== undefined;
  return (
    <SectionCard
      flush
      // Behind the info mark: who may learn what a document says.
      info={t`Files ${name} reads when a question needs them. Anyone who may ask it can learn what they say.`}
      // What to give it, and what it gets from them (Ruben, 21 November:
      // say what people should drop in and how it helps the agent).
      description={t`Give ${name} what it should know by heart: a checklist, a price list, a policy. It reads them when a question needs them, so its answers follow your own documents.`}
      title={t`Documents`}
    >
      {editing ? (
        <div {...stylex.props(styles.zone)}>
          <FileUpload
            accept={accepted}
            disabled={!can}
            description={t`PDF, Word, Excel, Markdown, text, CSV or JSON, up to 10 MB each.`}
            maxFileSize={chatFileMaxBytes}
            multiple
            onUpload={send}
            onValueChange={setFiles}
            value={files}
            variant="dropzone"
          />
        </div>
      ) : null}
      {documents === undefined ? (
        <Empty size="sm" variant="destructive">
          <EmptyHeader>
            <EmptyMedia />
            <EmptyTitle />
            <EmptyDescription>{t`The documents couldn't be loaded. Reload the page.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {/* Where documents can be added, the button to add them says enough. */}
      {documents?.length === 0 && !editing ? (
        <Empty size="sm">
          <EmptyHeader>
            <EmptyDescription>{t`${name} has no documents.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {documents === undefined || documents.length === 0 ? null : (
        <SeparatedItems
          aria-label={t`Documents`}
          rows={documents.map((document) => {
            const file = document.name;
            const size = formatBytes(document.bytes);
            const when = added(document.addedAt);
            return {
              key: document.id,
              row: (
                <Item key={document.id} size="sm">
                  <ItemMedia variant="default">
                    <Icon icon={FileIcon} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{file}</ItemTitle>
                    <ItemDescription>{t`${size} · Added ${when}`}</ItemDescription>
                  </ItemContent>
                  {editable ? (
                    <ItemActions>
                      {/* Asks first: a removed document can't be put back without its file. */}
                      <RemoveDocument
                        can={can}
                        file={file}
                        remove={async () =>
                          await change(async (session) => {
                            await session.connections.removeAgentDocument(
                              agent.id,
                              document.id
                            );
                          })
                        }
                      />
                    </ItemActions>
                  ) : null}
                </Item>
              ),
            };
          })}
        />
      )}
    </SectionCard>
  );
};
