import { agentErrors } from "@grasp-os/shared/agent";
import { agentDocumentsMax } from "@grasp-os/shared/agents";
import type { Agent, AgentDocument } from "@grasp-os/shared/agents";
import {
  chatFileMaxBytes,
  chatFileTypeOf,
  chatFileTypes,
} from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRef } from "react";

import type { Session } from "../core.ts";
import { formatBytes } from "../format.ts";
import { Row } from "../settings/stephen-settings.tsx";

// An agent's documents, on its page's Instructions tab (agent-page.tsx):
// files an admin gives it to answer from, such as a checklist or a policy
// too long for its instructions. Core reads each file's text once and
// keeps only that (agent-documents.ts); the agent is told its documents
// by name and reads one when a question needs it. Whoever may ask the
// agent may learn what a document says, and the card says so where one
// is added. Its rows are Settings › Stephen's (`Row`), on a card.

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
          throw agentErrors.create("agent.file_unsupported");
        }
        if (file.size > chatFileMaxBytes) {
          throw agentErrors.create("agent.file_too_large");
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
    <>
      <li className="flex flex-col gap-0.5 border-t px-5 py-4">
        <span className="font-medium">
          <Trans>Documents</Trans>
        </span>
        <span className="text-muted-foreground">
          {t`Files ${name} answers from, such as a checklist or a policy. It reads one when a question needs it. Anyone who may ask ${name} can learn what these say.`}
        </span>
      </li>
      {documents === undefined ? (
        <li className="text-muted-foreground border-t px-5 py-4">
          {t`The documents couldn't be loaded. Reload the page.`}
        </li>
      ) : (
        documents.map((document) => {
          const file = document.name;
          const size = formatBytes(document.bytes);
          const when = added(document.addedAt);
          return (
            <Row
              description={t`${size} · Added ${when}`}
              key={document.id}
              name={file}
            >
              {editable ? (
                <Button
                  aria-label={t`Remove ${file}`}
                  disabled={!can}
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
                >
                  <Trans>Remove</Trans>
                </Button>
              ) : null}
            </Row>
          );
        })
      )}
      {documents?.length === 0 && !editable ? (
        <li className="text-muted-foreground border-t px-5 py-4">
          {t`${name} has no documents.`}
        </li>
      ) : null}
      {editable && documents !== undefined ? (
        <li className="flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
          <span className="text-muted-foreground">
            {full
              ? t`${name} has ${most} documents, the most an agent keeps. Remove one to add another.`
              : t`PDF, Word, Excel, Markdown, text, CSV or JSON, up to 10 MB each. At most ${most} documents.`}
          </span>
          <input
            accept={accepted}
            aria-hidden="true"
            className="hidden"
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
          />
          <Button
            className="flex-none"
            disabled={!can || full}
            onClick={() => {
              input.current?.click();
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Add document</Trans>
          </Button>
        </li>
      ) : null}
    </>
  );
};
