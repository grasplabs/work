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
import { useRef } from "react";

import type { Session } from "../core.ts";
import { formatBytes } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { File as FileIcon, Trash, Upload } from "../grasp/icons/index.ts";
import { Item, ItemGroup } from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";

// An agent's documents, on its page's Instructions tab (agent-page.tsx):
// files an admin gives it to answer from, such as a checklist or a policy
// too long for its instructions. Core reads each file's text once and
// keeps only that (agent-documents.ts); the agent is told its documents
// by name and reads one when a question needs it. Whoever may ask the
// agent may learn what a document says, and the card says so where one
// is added. A card of Grasp UI's Items; Add document opens the file
// picker, as Grasp UI has no file drop part yet.

const styles = stylex.create({
  // The picker itself is never seen: Add document opens it.
  picker: { display: "none" },
});

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

/** What the file picker offers: the extensions core takes. */
const accepted = Object.keys(chatFileTypes)
  .map((extension) => `.${extension}`)
  .join(",");

/** The rows of `agent`'s documents, and the way to add one. */
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
  const input = useRef<HTMLInputElement>(null);
  const { name } = agent;
  const most = agentDocumentsMax;
  const full = (documents?.length ?? 0) >= agentDocumentsMax;
  const added = (at: string): string =>
    new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
      new Date(at)
    );
  const add = (files: readonly File[]): void => {
    if (files.length === 0) {
      return;
    }
    void change(async (session) => {
      // One after another: core counts each against the most an agent
      // keeps, and the first it refuses says why.
      for (const file of files) {
        // Refused here as core would, before it is sent at all: a file
        // past what one message to core holds would drop the connection,
        // and every call waiting on it, before core could say why.
        if (chatFileTypeOf(file.name) === undefined) {
          throw agentErrors.create("agent.document_unsupported");
        }
        if (file.size > chatFileMaxBytes) {
          throw agentErrors.create("agent.document_too_large");
        }
        // oxlint-disable-next-line no-await-in-loop -- in order, stopping at the first refused
        const bytes = new Uint8Array(await file.arrayBuffer());
        // oxlint-disable-next-line no-await-in-loop -- in order, stopping at the first refused
        await session.connections.addAgentDocument(agent.id, {
          name: file.name,
          bytes,
        });
      }
    });
  };
  return (
    <SectionCard
      actions={
        editable && documents !== undefined ? (
          <>
            <input
              accept={accepted}
              aria-hidden="true"
              data-testid="agent-document-input"
              multiple
              onChange={(event) => {
                add([...(event.target.files ?? [])]);
                // The same file can be picked again once it was removed.
                event.target.value = "";
              }}
              ref={input}
              tabIndex={-1}
              type="file"
              {...stylex.props(styles.picker)}
            />
            <Button
              disabled={!can || full}
              icon={Upload}
              onClick={() => {
                input.current?.click();
              }}
              size="sm"
            >
              {t`Add document`}
            </Button>
          </>
        ) : undefined
      }
      description={t`Files ${name} reads when a question needs them. Anyone who may ask it can learn what they say.`}
      flush
      footer={
        editable && documents !== undefined ? (
          <Text size="xs" tone="muted">
            {full
              ? t`${name} has ${most} documents, the most an agent keeps. Remove one to add another.`
              : t`PDF, Word, Excel, Markdown, text, CSV or JSON, up to 10 MB each. At most ${most} documents.`}
          </Text>
        ) : undefined
      }
      title={t`Documents`}
    >
      {documents === undefined ? (
        <Empty kind="error" size="inline">
          {t`The documents couldn't be loaded. Reload the page.`}
        </Empty>
      ) : null}
      {documents?.length === 0 ? (
        <Empty size="inline">{t`${name} has no documents.`}</Empty>
      ) : null}
      {documents === undefined || documents.length === 0 ? null : (
        <ItemGroup separated>
          {documents.map((document) => {
            const file = document.name;
            const size = formatBytes(document.bytes);
            const when = added(document.addedAt);
            return (
              <Item
                actions={
                  editable ? (
                    <Button
                      disabled={!can}
                      icon={Trash}
                      label={t`Remove ${file}`}
                      onClick={() => {
                        void change(async (session) => {
                          await session.connections.removeAgentDocument(
                            agent.id,
                            document.id
                          );
                        });
                      }}
                      size="sm"
                      variant="ghost"
                    />
                  ) : undefined
                }
                description={t`${size} · Added ${when}`}
                icon={FileIcon}
                iconLook="inline"
                key={document.id}
                size="sm"
                title={file}
              />
            );
          })}
        </ItemGroup>
      )}
    </SectionCard>
  );
};
