import { agentErrors } from "@grasp-os/shared/agent";
import { agentDocumentsMax } from "@grasp-os/shared/agents";
import type { Agent, AgentDocument } from "@grasp-os/shared/agents";
import {
  chatFileMaxBytes,
  chatFileTypeOf,
  chatFileTypes,
} from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { Session } from "../core.ts";
import { formatBytes } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { FileUpload } from "../grasp/file-upload/index.ts";
import { File as FileIcon, Trash } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// An agent's documents, on its page's Instructions part (agent-page.tsx):
// files an admin gives it to answer from, such as a checklist or a policy
// too long for its instructions. Core reads each file's text once and
// keeps only that (agent-documents.ts); the agent is told its documents
// by name and reads one when a question needs it. Whoever may ask the
// agent may learn what a document says, and the card says so where one
// is added (behind the card's info mark). A card of Grasp UI's Items, with
// File upload's button in its head ("Add documents"): each file is sent to
// core as it is chosen, said on its own row in the card's body under the
// documents, and once core keeps it, it is a document's row.

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

const styles = stylex.create({
  // Where File upload draws the files on their way to core: room around
  // them in the flush card while there are any, none when there are none.
  sending: {
    padding: { default: 0, ":has(li)": grasp.space3 },
  },
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
  // The card's body, where File upload lists the files it is sending.
  const [sending, setSending] = useState<HTMLDivElement | null>(null);
  const most = agentDocumentsMax;
  const kept = documents?.length ?? 0;
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
  };
  const editing = editable && documents !== undefined;
  return (
    <SectionCard
      density="compact"
      flush
      // Behind the info mark: who may learn what a document says.
      info={t`Files ${name} reads when a question needs them. Anyone who may ask it can learn what they say.`}
      actions={
        editing && kept < most ? (
          <FileUpload
            accept={accepted}
            disabled={!can}
            // Each file a new list: those core kept are documents' rows.
            key={kept}
            listIn={sending}
            maxFiles={most - kept}
            maxSize={chatFileMaxBytes}
            multiple
            // Said to a screen reader on the button; refusals say the rest.
            hint={t`PDF, Word, Excel, Markdown, text, CSV or JSON, up to 10 MB each. At most ${most} documents.`}
            upload={send}
            variant="button"
            words={{
              choose: t`Add documents`,
              uploading: t`Adding`,
              done: t`Added`,
              failed: t`Not added`,
              retry: t`Try again`,
              files: t`Files`,
              doneLine: (size) => t`${size}, added`,
              sent: (file) => t`${file} added.`,
              notSent: (file) => t`${file} wasn't added.`,
              remove: (file) => t`Remove ${file}`,
              refused: (file, reason) => {
                if (reason === "file-too-large") {
                  return t`${file} is larger than 10 MB.`;
                }
                if (reason === "too-many-files") {
                  return t`${file} is one more than ${most} documents.`;
                }
                return t`${file} isn't a kind of file an agent reads.`;
              },
            }}
          />
        ) : undefined
      }
      title={t`Documents`}
    >
      {documents === undefined ? (
        <Empty size="inline" tone="danger">
          {t`The documents couldn't be loaded. Reload the page.`}
        </Empty>
      ) : null}
      {/* Where documents can be added, the button to add them says enough. */}
      {documents?.length === 0 && !editing ? (
        <Empty size="inline">{t`${name} has no documents.`}</Empty>
      ) : null}
      {editing && kept >= most ? (
        <Empty size="inline">
          {t`${name} has ${most} documents, the most an agent keeps. Remove one to add another.`}
        </Empty>
      ) : null}
      {documents === undefined || documents.length === 0 ? null : (
        <ItemGroup aria-label={t`Documents`} separated>
          {documents.map((document) => {
            const file = document.name;
            const size = formatBytes(document.bytes);
            const when = added(document.addedAt);
            return (
              <Item key={document.id} size="sm">
                <ItemMedia icon={FileIcon} iconLook="inline" />
                <ItemContent>
                  <ItemTitle>{file}</ItemTitle>
                  <ItemDescription>{t`${size} · Added ${when}`}</ItemDescription>
                </ItemContent>
                {editable ? (
                  <ItemActions>
                    {/* Asks first: a removed document can't be put back without its file. */}
                    <AlertDialog>
                      <AlertDialogTrigger
                        aria-label={t`Remove ${file}`}
                        disabled={!can}
                        icon={Trash}
                        size="sm"
                        variant="ghost"
                      />
                      <AlertDialogContent>
                        <AlertDialogTitle>{t`Remove ${file}?`}</AlertDialogTitle>
                        <AlertDialogFooter>
                          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
                          <AlertDialogAction
                            action={async () => {
                              await change(async (session) => {
                                await session.connections.removeAgentDocument(
                                  agent.id,
                                  document.id
                                );
                              });
                            }}
                            failedLabel={t`Couldn't remove`}
                            variant="danger"
                          >
                            {t`Remove`}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </ItemActions>
                ) : null}
              </Item>
            );
          })}
        </ItemGroup>
      )}
      <div ref={setSending} {...stylex.props(styles.sending)} />
    </SectionCard>
  );
};
