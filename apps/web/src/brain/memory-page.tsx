import { failureText } from "@grasp-os/shared/errors";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { FileTextIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { LessonsView } from "./lessons-view.tsx";
import { recordOf } from "./memory-parts.tsx";
import { RememberDialog } from "./remember-dialog.tsx";
import { ShareRecord, shareTargets } from "./share-record.tsx";

// The Brain's memory records, as a person inspects and corrects them
// (GRA-298; the threat model is on the issue): their own, or the shared
// records of others their memory reads; and one record's lineage, as far
// as they may follow it now, with what superseded it. Core decides what
// they see and what they may change: this page shows what it answers, and
// offers a correction or a retirement only where core would take it.
// Statements, names and titles are text, never markup.

type Knowledge = Session["knowledge"];
type Page = Awaited<ReturnType<Knowledge["memoriesList"]>>;
type Lineage = Awaited<ReturnType<Knowledge["memoriesLineage"]>>;
type Shown = Lineage["record"];
type Among = "mine" | "shared";
type Tab = Among | "lessons";

/** What a read from core came to. */
type Read<T> =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

/**
 * What `read` answers on the person's session, or why not. Outside the
 * components, as the React Compiler can't compile `try`.
 */
const readFrom = async <T,>(
  core: CoreConnection,
  read: (knowledge: Knowledge) => Promise<T>
): Promise<Read<T>> => {
  try {
    const data = await core.withSession(
      async (session) => await read(session.knowledge)
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

const StateBadge = ({ state }: { state: Shown["state"] }) => {
  const { t } = useLingui();
  const label = {
    accepted: t({ message: "Accepted", context: "memory record state" }),
    proposed: t({ message: "Proposed", context: "memory record state" }),
    retired: t({ message: "Retired", context: "memory record state" }),
  }[state];
  return (
    <Badge variant={state === "accepted" ? "secondary" : "outline"}>
      {label}
    </Badge>
  );
};

const ScopeBadge = ({ scope }: { scope: Shown["scope"] }) => {
  const { t } = useLingui();
  const label = {
    person: t({ message: "Yours", context: "memory record scope" }),
    session: t({ message: "This chat", context: "memory record scope" }),
    team: t({ message: "Team", context: "memory record scope" }),
    company: t({ message: "Company", context: "memory record scope" }),
  }[scope];
  return <Badge variant="outline">{label}</Badge>;
};

/** A record's statement with what it is: a row to pick, or the one in hand. */
const RecordLine = ({
  record,
  by,
  onPick,
  picked,
}: {
  record: Omit<Shown, "by">;
  by?: string | null;
  onPick?: () => void;
  picked?: boolean;
}) => {
  const body = (
    <>
      <span className="min-w-0 text-sm">
        {record.withheld === true ? (
          <span className="text-muted-foreground italic">
            <Trans>Cites a source you no longer have access to</Trans>
          </span>
        ) : (
          record.statement
        )}
      </span>
      <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <ScopeBadge scope={record.scope} />
        <StateBadge state={record.state} />
        <span>
          <Trans>Revision {record.revision}</Trans>
        </span>
        <span>{formatDateTime(record.recordedAt)}</span>
        {by === undefined || by === null ? null : (
          <span>
            <Trans>By {by}</Trans>
          </span>
        )}
      </span>
    </>
  );
  return onPick === undefined ? (
    <div className="flex flex-col gap-1.5">{body}</div>
  ) : (
    <button
      aria-pressed={picked}
      className="hover:bg-accent aria-pressed:bg-accent flex w-full flex-col items-start gap-1.5 rounded-md px-3 py-2 text-left"
      onClick={onPick}
      type="button"
    >
      {body}
    </button>
  );
};

/** What a record rests on, as far as the person may follow it. */
const RestsOn = ({
  lineage,
  onPick,
}: {
  lineage: Lineage;
  onPick: (memoryId: string) => void;
}) => {
  if (lineage.restsOn.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>It rests on nothing you can see.</Trans>
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {lineage.restsOn.map((node) =>
        node.kind === "memory" ? (
          <li
            className="border-l pl-3"
            key={`${node.citedBy}>${node.record.id}`}
          >
            <RecordLine
              by={node.record.by}
              onPick={() => {
                onPick(node.record.id);
              }}
              record={node.record}
            />
            {node.citedRevision === node.record.revision ? null : (
              <p className="text-muted-foreground px-3 text-xs">
                <Trans>
                  Cited at revision {node.citedRevision}; it is at revision{" "}
                  {node.record.revision} now.
                </Trans>
              </p>
            )}
          </li>
        ) : (
          <li
            className="flex items-start gap-2 border-l pl-3 text-sm"
            key={`${node.citedBy}>${node.documentId}@${node.version}`}
          >
            <FileTextIcon className="text-muted-foreground mt-0.5 size-4 flex-none" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{node.title}</span>
              <span className="text-muted-foreground text-xs">
                {node.path}
                {" · "}
                {node.version === node.currentVersion ? (
                  <Trans>version {node.version}, the current one</Trans>
                ) : (
                  <Trans>
                    version {node.version}; it is at version{" "}
                    {node.currentVersion} now
                  </Trans>
                )}
              </span>
            </span>
          </li>
        )
      )}
    </ul>
  );
};

/** A correction of one of the person's own records, against its revision. */
const CorrectForm = ({
  record,
  onDone,
}: {
  record: Shown;
  onDone: (memoryId: string | undefined) => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [statement, setStatement] = useState(record.statement);
  const id = useId();
  const changed =
    statement.trim() !== "" && statement.trim() !== record.statement;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          const receipt = await run(
            async (session) =>
              await session.knowledge.memoriesProposeChange(
                { memoryId: record.id, statement: statement.trim() },
                {
                  idempotencyKey: crypto.randomUUID(),
                  expectedRevision: record.revision,
                }
              )
          );
          if (receipt !== undefined) {
            onDone(recordOf(receipt));
          }
        })();
      }}
    >
      <label className="text-sm font-medium" htmlFor={id}>
        <Trans>Correct it</Trans>
      </label>
      <Textarea
        id={id}
        onChange={(event) => {
          setStatement(event.target.value);
        }}
        placeholder={t`What it should say`}
        value={statement}
      />
      {failure === undefined ? null : <ErrorText>{failure}</ErrorText>}
      <div>
        <Button disabled={busy || !changed} type="submit">
          <Trans>Save the correction</Trans>
        </Button>
      </div>
    </form>
  );
};

/** Retires a shared record, where core would take it. */
const RetireButton = ({
  record,
  onDone,
}: {
  record: Shown;
  onDone: () => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          disabled={busy}
          onClick={() => {
            void (async () => {
              const receipt = await run(
                async (session) =>
                  await session.knowledge.memoriesRetire(
                    { memoryId: record.id },
                    {
                      idempotencyKey: crypto.randomUUID(),
                      expectedRevision: record.revision,
                    }
                  )
              );
              if (receipt !== undefined) {
                onDone();
              }
            })();
          }}
          variant="outline"
        >
          <Trans>Retire it</Trans>
        </Button>
      </div>
      {failure === undefined ? null : <ErrorText>{failure}</ErrorText>}
    </div>
  );
};

/** One record's lineage, and what the person may do with it. */
const LineagePanel = ({
  memoryId,
  admin,
  teams,
  onPick,
  onChanged,
}: {
  memoryId: string;
  admin: boolean;
  teams: readonly { id: string; name: string }[];
  onPick: (memoryId: string) => void;
  onChanged: (memoryId: string | undefined) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  // Keyed by the record: another record is another panel, read afresh.
  const [answered, setAnswered] = useState<Read<Lineage>>({
    state: "loading",
  });
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (knowledge) => await knowledge.memoriesLineage({ memoryId })
      );
      if (!left) {
        setAnswered(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core, memoryId]);
  if (answered.state === "loading") {
    return null;
  }
  if (answered.state === "refused") {
    return <ErrorText>{answered.message}</ErrorText>;
  }
  const lineage = answered.data;
  const { record } = lineage;
  const own = record.by === null;
  const withheld = record.withheld === true;
  const correctable =
    own && !withheld && record.scope === "person" && record.state !== "retired";
  // One's own, any scope, by them; a shared one by an admin too. One they
  // may no longer read, withheld, only so.
  // One's own, in their own memory, into a scope they may share with.
  const shareable = correctable && shareTargets(teams, admin).length > 0;
  const retirable =
    record.state !== "retired" && (own || (admin && record.scope !== "person"));
  return (
    <section
      aria-label={
        withheld
          ? t`Cites a source you no longer have access to`
          : record.statement
      }
      className="flex flex-col gap-5 rounded-lg border p-4"
    >
      <RecordLine by={record.by} record={record} />
      {lineage.supersededBy === null ? null : (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">
            <Trans>Corrected by</Trans>
          </h3>
          <RecordLine
            by={lineage.supersededBy.by}
            onPick={() => {
              if (lineage.supersededBy !== null) {
                onPick(lineage.supersededBy.id);
              }
            }}
            record={lineage.supersededBy}
          />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">
          <Trans>What it rests on</Trans>
        </h3>
        <RestsOn lineage={lineage} onPick={onPick} />
      </div>
      {correctable ? (
        <CorrectForm key={record.revision} onDone={onChanged} record={record} />
      ) : null}
      {shareable ? (
        <ShareRecord
          admin={admin}
          onShared={onChanged}
          record={record}
          teams={teams}
        />
      ) : null}
      {retirable ? (
        <RetireButton
          onDone={() => {
            onChanged(record.id);
          }}
          record={record}
        />
      ) : null}
    </section>
  );
};

/**
 * The records of `among`, newest first, to pick one from. Keyed by what it
 * lists and the changes made: a change lists them again, as they are now.
 */
const RecordList = ({
  among,
  picked,
  onPick,
}: {
  among: Among;
  picked: string | undefined;
  onPick: (memoryId: string) => void;
}) => {
  const core = useCore();
  const [listed, setListed] = useState<Read<Page>>({ state: "loading" });
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (knowledge) => await knowledge.memoriesList({ among })
      );
      if (!left) {
        setListed(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core, among]);
  return (
    <div className="flex flex-col gap-1">
      {listed.state === "refused" ? (
        <ErrorText>{listed.message}</ErrorText>
      ) : null}
      {listed.state === "ready" && listed.data.records.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              <Trans>No records yet</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>
                What you and your agents remember, and what others share with
                you, shows here.
              </Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {listed.state === "ready"
        ? listed.data.records.map((record) => (
            <RecordLine
              key={record.id}
              onPick={() => {
                onPick(record.id);
              }}
              picked={picked === record.id}
              record={record}
            />
          ))
        : null}
    </div>
  );
};

/** The Brain's memory page: the records, and the one in hand. */
export const MemoryPage = ({
  admin,
  teams,
}: {
  admin: boolean;
  /** The teams the person is in, to share their records with. */
  teams: readonly { id: string; name: string }[];
}) => {
  const [tab, setTab] = useState<Tab>("mine");
  const [picked, setPicked] = useState<string>();
  // Read again after a change: what changed shows as it is now.
  const [changes, setChanges] = useState(0);
  return (
    // A page of the brain as its log is (brain-log.tsx): the title in the
    // serif, the kinds of record as a line of tabs under it, in the brain's
    // column, with room at the foot for the chat.
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="pb-chat mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 pt-8 md:px-12">
        <PageHeader>
          <PageHeaderTitle>
            <Trans>Memory</Trans>
          </PageHeaderTitle>
          <PageHeaderActions>
            <RememberDialog
              onRemembered={(memoryId) => {
                setTab("mine");
                setChanges((count) => count + 1);
                setPicked(memoryId);
              }}
            />
          </PageHeaderActions>
        </PageHeader>
        <Tabs
          onValueChange={(value: string) => {
            setTab(value === "shared" || value === "lessons" ? value : "mine");
            setPicked(undefined);
          }}
          value={tab}
        >
          <TabsList variant="line">
            <TabsTrigger className="flex-none" value="mine">
              <Trans context="memory records: the person's own">Yours</Trans>
            </TabsTrigger>
            <TabsTrigger className="flex-none" value="shared">
              <Trans context="memory records: others' that you read">
                Shared with you
              </Trans>
            </TabsTrigger>
            <TabsTrigger className="flex-none" value="lessons">
              <Trans context="the Brain's lessons from repeated failures">
                Lessons
              </Trans>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "lessons" ? (
          <LessonsView admin={admin} />
        ) : (
          <div className="grid min-h-0 gap-6 lg:grid-cols-2">
            <RecordList
              among={tab}
              key={`${tab}:${changes}`}
              onPick={setPicked}
              picked={picked}
            />
            {picked === undefined ? null : (
              <LineagePanel
                admin={admin}
                teams={teams}
                key={`${picked}:${changes}`}
                memoryId={picked}
                onChanged={(memoryId) => {
                  setChanges((count) => count + 1);
                  setPicked(memoryId);
                }}
                onPick={setPicked}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
