import { agentErrors } from "@grasp-os/shared/agent";
import type { Agent, AgentDocument } from "@grasp-os/shared/agents";
import {
  chatFileMaxBytes,
  chatFileTypeOf,
  chatFileTypes,
} from "@grasp-os/shared/chat";
import {
  AlertDialog,
  AlertDialogAction,
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
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { FileUpload } from "@grasp-os/ui/components/file-upload";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { FileIcon, Icon, TrashIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment, useState } from "react";

import { formatBytes } from "../format.ts";
import { SettingsCard } from "./settings-card.tsx";
import type { Change } from "./settings-card.tsx";

// An agent's documents, on its page's Instructions part (agent-page.tsx):
// files an admin gives it to answer from, such as a checklist or a policy
// too long for its instructions. Core reads each file's text once and
// keeps only that (agent-documents.ts); the agent is told its documents
// by name and reads one when a question needs it. Whoever may ask the
// agent may learn what a document says, and the card says so where one
// is added (behind the card's info mark). A card of Damsko's Items under
// File upload's drop zone, with a line on what to give it and why: each
// file is sent to core as it is dropped or chosen, said on its row in the
// zone, and once core keeps it, it is a document's row.

const styles = stylex.create({
  // The drop zone, inset in the flush card above the documents.
  zone: { padding: space["3"] },
});

/** The kinds of file core takes, by their extensions. */
const accepted = Object.keys(chatFileTypes).map((extension) => `.${extension}`);

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
  // The files in the drop zone: those on their way, or that failed. One
  // core kept leaves it, a document's row now; the others stay as they are.
  const [files, setFiles] = useState<File[]>([]);
  const added = (at: string): string =>
    new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
      new Date(at)
    );
  // One file to core. It throws when core didn't take it, so File upload
  // says so on the file's row; why is said under the page's header.
  const send = async (file: File): Promise<void> => {
    let sent = false;
    await change(async (session) => {
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
      sent = true;
    });
    if (!sent) {
      throw new Error(t`Not added`);
    }
    setFiles((now) => now.filter((each) => each !== file));
  };
  const editing = editable && documents !== undefined;
  return (
    <SettingsCard
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
            description={t`PDF, Word, Excel, Markdown, text, CSV or JSON, up to 10 MB each.`}
            maxFileSize={chatFileMaxBytes}
            multiple
            onUpload={send}
            onValueChange={setFiles}
            value={files}
          />
        </div>
      ) : null}
      {documents === undefined ? (
        <Empty size="sm" variant="destructive">
          <EmptyHeader>
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
        <ItemGroup aria-label={t`Documents`}>
          {documents.map((document, index) => {
            const file = document.name;
            const size = formatBytes(document.bytes);
            const when = added(document.addedAt);
            return (
              <Fragment key={document.id}>
                {index === 0 ? null : <ItemSeparator />}
                <Item size="sm">
                  <ItemMedia>
                    <Icon icon={FileIcon} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{file}</ItemTitle>
                    <ItemDescription>{t`${size} · Added ${when}`}</ItemDescription>
                  </ItemContent>
                  {editable ? (
                    <ItemActions>
                      {/* Asks first: a removed document can't be put back without its file. */}
                      <AlertDialog>
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
                            <AlertDialogAction
                              onClick={() => {
                                void change(async (session) => {
                                  await session.connections.removeAgentDocument(
                                    agent.id,
                                    document.id
                                  );
                                });
                              }}
                              variant="destructive"
                            >
                              {t`Remove`}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </ItemActions>
                  ) : null}
                </Item>
              </Fragment>
            );
          })}
        </ItemGroup>
      )}
    </SettingsCard>
  );
};
