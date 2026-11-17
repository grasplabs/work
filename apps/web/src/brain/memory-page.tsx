import { failureText } from "@grasp-os/shared/errors";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Badge } from "../grasp/badge/index.ts";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { File, Note } from "../grasp/icons/index.ts";
import { InspectorPanel } from "../grasp/inspector-panel/index.ts";
import type { InspectorSection } from "../grasp/inspector-panel/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { Tabs, TabsList, TabsTrigger } from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { LessonsView } from "./lessons-view.tsx";
import { CardWords, FactLine, recordOf } from "./memory-parts.tsx";
import type { Fact } from "./memory-parts.tsx";
import { RememberDialog } from "./remember-dialog.tsx";
import { ShareRecord } from "./share-record.tsx";

// The Brain's memory records, as a person inspects and corrects them
// (GRA-298; the threat model is on the issue): their own, or the shared
// records of others their memory reads; and one record's lineage, as far
// as they may follow it now, with what superseded it, in the inspector
// beside the list. Core decides what they see and what they may change:
// this page shows what it answers, and offers a correction or a
// retirement only where core would take it. A correction is a dialog's
// task; a retirement asks first, as nothing brings a record back.
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

const styles = stylex.create({
  // A page of the brain as its log is (brain-log.tsx): in the brain's
  // column, scrolling on its own, with room at the foot for the chat.
  scroll: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.pageMeasure,
    marginInline: "auto",
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  // The list, and the record in hand beside it once the page is wide
  // enough; under it on a narrow one.
  split: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromSidebar]: `minmax(0, 1fr) ${grasp.inspectorWidth}`,
    },
    gap: grasp.space6,
    alignItems: "start",
    minWidth: 0,
  },
  list: { display: "grid", gap: grasp.space2, minWidth: 0 },
});

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

/** A record's state: accepted, as done, in green; the others in words. */
const StateMark = ({ state }: { state: Shown["state"] }) => {
  const { t } = useLingui();
  const label = {
    accepted: t({ message: "Accepted", context: "memory record state" }),
    proposed: t({ message: "Proposed", context: "memory record state" }),
    retired: t({ message: "Retired", context: "memory record state" }),
  }[state];
  return state === "accepted" ? (
    <Badge size="sm" tone="success">
      {label}
    </Badge>
  ) : (
    label
  );
};

const ScopeLabel = ({ scope }: { scope: Shown["scope"] }) => {
  const { t } = useLingui();
  return {
    person: t({ message: "Yours", context: "memory record scope" }),
    session: t({ message: "This chat", context: "memory record scope" }),
    team: t({ message: "Team", context: "memory record scope" }),
    company: t({ message: "Company", context: "memory record scope" }),
  }[scope];
};

/** What a record is: where it is shared, its state, revision, time and author. */
const factsOf = (
  record: Omit<Shown, "by">,
  by: string | null | undefined
): Fact[] => [
  { id: "scope", fact: <ScopeLabel scope={record.scope} /> },
  { id: "state", fact: <StateMark state={record.state} /> },
  { id: "revision", fact: <Trans>Revision {record.revision}</Trans> },
  { id: "at", fact: formatDateTime(record.recordedAt) },
  ...(by === undefined || by === null
    ? []
    : [{ id: "by", fact: <Trans>By {by}</Trans> }]),
];

/** A record's statement, or that it cites what the person may no longer read. */
const Statement = ({ record }: { record: Omit<Shown, "by"> }) =>
  record.withheld === true ? (
    <Text element="span" tone="muted">
      <Trans>Cites a source you no longer have access to</Trans>
    </Text>
  ) : (
    record.statement
  );

/** A record as a row to pick: its statement, and what it is under it. */
const RecordItem = ({
  record,
  by,
  note,
  onPick,
  picked = false,
}: {
  record: Omit<Shown, "by">;
  by?: string | null;
  /** A second line, after what it is: how its citation stands. */
  note?: ReactNode;
  onPick: () => void;
  picked?: boolean;
}) => {
  const { t } = useLingui();
  const name =
    record.withheld === true
      ? t`Cites a source you no longer have access to`
      : record.statement;
  return (
    <Item
      current={picked}
      render={<button aria-label={name} onClick={onPick} type="button" />}
      size="sm"
    >
      <ItemMedia icon={Note} iconLook="inline" />
      <ItemContent>
        <ItemTitle>
          <Statement record={record} />
        </ItemTitle>
        <ItemDescription>
          <FactLine facts={factsOf(record, by)} />
        </ItemDescription>
        {note === undefined ? null : <ItemDescription>{note}</ItemDescription>}
      </ItemContent>
    </Item>
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
      <CardWords>
        <Text size="sm" tone="muted">
          <Trans>It rests on nothing you can see.</Trans>
        </Text>
      </CardWords>
    );
  }
  return (
    <ItemGroup separated>
      {lineage.restsOn.map((node) =>
        node.kind === "memory" ? (
          <RecordItem
            by={node.record.by}
            key={`${node.citedBy}>${node.record.id}`}
            note={
              node.citedRevision === node.record.revision ? undefined : (
                <Trans>
                  Cited at revision {node.citedRevision}; it is at revision{" "}
                  {node.record.revision} now.
                </Trans>
              )
            }
            onPick={() => {
              onPick(node.record.id);
            }}
            record={node.record}
          />
        ) : (
          <Item
            key={`${node.citedBy}>${node.documentId}@${node.version}`}
            size="sm"
          >
            <ItemMedia icon={File} iconLook="inline" />
            <ItemContent>
              <ItemTitle>{node.title}</ItemTitle>
              <ItemDescription>
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
              </ItemDescription>
            </ItemContent>
          </Item>
        )
      )}
    </ItemGroup>
  );
};

/** The correction's form, a fresh one for each opening. */
const CorrectForm = ({
  record,
  onDone,
}: {
  record: Shown;
  onDone: (memoryId: string | undefined) => void;
}) => {
  const { t } = useLingui();
  const { failure, run } = useCoreAction();
  const [statement, setStatement] = useState(record.statement);
  const changed =
    statement.trim() !== "" && statement.trim() !== record.statement;
  const correct = async (): Promise<void> => {
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
    if (receipt === undefined) {
      // The dialog stays open, with core's reason under the field.
      throw new Error("The correction wasn't saved.");
    }
    onDone(recordOf(receipt));
  };
  return (
    <>
      <DialogBody>
        <Field>
          <FieldLabel>{t`What it should say`}</FieldLabel>
          <Textarea
            onValueChange={(value) => {
              setStatement(value);
            }}
            value={statement}
          />
        </Field>
        <ErrorText>{failure}</ErrorText>
      </DialogBody>
      <DialogFooter>
        <DialogAction>{t`Cancel`}</DialogAction>
        <DialogAction
          action={correct}
          disabled={!changed}
          failedLabel={t`Not saved`}
          variant="ink"
          workingLabel={t`Saving`}
        >
          {t`Save the correction`}
        </DialogAction>
      </DialogFooter>
    </>
  );
};

/** A correction of one of the person's own records, against its revision. */
const CorrectRecord = ({
  record,
  onDone,
}: {
  record: Shown;
  onDone: (memoryId: string | undefined) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger size="xs">{t`Correct it`}</DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Correct it`}</DialogTitle>
        {open ? <CorrectForm onDone={onDone} record={record} /> : null}
      </DialogContent>
    </Dialog>
  );
};

/** Retires a record, where core would take it, once the person says so. */
const RetireRecord = ({
  record,
  onDone,
}: {
  record: Shown;
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const { failure, run } = useCoreAction();
  const retire = async (): Promise<void> => {
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
    if (receipt === undefined) {
      // It stays open, with core's reason in it.
      throw new Error("The record wasn't retired.");
    }
    onDone();
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger size="xs">{t`Retire it`}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Retire this record?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`Grasp and your agents stop using it. It stays here, as retired.`}
        </AlertDialogDescription>
        <ErrorText>{failure}</ErrorText>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Keep it`}</AlertDialogAction>
          <AlertDialogAction
            action={retire}
            failedLabel={t`Not retired`}
            variant="danger"
            workingLabel={t`Retiring`}
          >
            {t({ message: "Retire", context: "confirm retiring a record" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** One record's lineage, and what the person may do with it. */
const LineagePanel = ({
  memoryId,
  admin,
  teams,
  onPick,
  onChanged,
  onClose,
}: {
  memoryId: string;
  admin: boolean;
  teams: readonly { id: string; name: string }[];
  onPick: (memoryId: string) => void;
  onChanged: (memoryId: string | undefined) => void;
  onClose: () => void;
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
  const { record, supersededBy } = lineage;
  const own = record.by === null;
  const withheld = record.withheld === true;
  const correctable =
    own && !withheld && record.scope === "person" && record.state !== "retired";
  // One's own, any scope, by them; a shared one by an admin too. One they
  // may no longer read, withheld, only so.
  const retirable =
    record.state !== "retired" && (own || (admin && record.scope !== "person"));
  const title = withheld
    ? t`Cites a source you no longer have access to`
    : record.statement;
  const sections: InspectorSection[] = [
    ...(supersededBy === null
      ? []
      : [
          {
            id: "corrected",
            label: t`Corrected by`,
            content: (
              <ItemGroup>
                <RecordItem
                  by={supersededBy.by}
                  onPick={() => {
                    onPick(supersededBy.id);
                  }}
                  record={supersededBy}
                />
              </ItemGroup>
            ),
          },
        ]),
    {
      id: "rests-on",
      label: t`What it rests on`,
      content: <RestsOn lineage={lineage} onPick={onPick} />,
    },
  ];
  return (
    <InspectorPanel
      actions={
        <>
          {correctable ? (
            <CorrectRecord onDone={onChanged} record={record} />
          ) : null}
          {/* One they may correct, they may share: the form says where. */}
          {correctable ? (
            <ShareRecord
              admin={admin}
              onShared={onChanged}
              record={record}
              teams={teams}
            />
          ) : null}
          {retirable ? (
            <RetireRecord
              onDone={() => {
                onChanged(record.id);
              }}
              record={record}
            />
          ) : null}
        </>
      }
      aria-label={title}
      icon={Note}
      meta={factsOf(record, record.by).map(({ fact }) => fact)}
      onClose={onClose}
      sections={sections}
      title={title}
      words={{ close: t`Close` }}
    />
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
  if (listed.state === "loading") {
    return null;
  }
  if (listed.state === "refused") {
    return <ErrorText>{listed.message}</ErrorText>;
  }
  if (listed.data.records.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <Trans>No records yet</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              What you and your agents remember, and what others share with you,
              shows here.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup>
      {listed.data.records.map((record) => (
        <RecordItem
          key={record.id}
          onPick={() => {
            onPick(record.id);
          }}
          picked={picked === record.id}
          record={record}
        />
      ))}
    </ItemGroup>
  );
};

/** Whether a tab's value is one of the page's. */
const tabOf = (value: unknown): Tab =>
  value === "shared" || value === "lessons" ? value : "mine";

/** The Brain's memory page: the records, and the one in hand. */
export const MemoryPage = ({
  admin,
  teams,
}: {
  admin: boolean;
  /** The teams the person is in, to share their records with. */
  teams: readonly { id: string; name: string }[];
}) => {
  const { t } = useLingui();
  const [tab, setTab] = useState<Tab>("mine");
  const [picked, setPicked] = useState<string>();
  // Read again after a change: what changed shows as it is now.
  const [changes, setChanges] = useState(0);
  return (
    // The title in the serif, the kinds of record as a line of tabs under
    // it, in the brain's column, with room at the foot for the chat.
    <div {...stylex.props(styles.scroll)}>
      <div {...stylex.props(styles.column)}>
        <PageHeader
          actions={
            <RememberDialog
              onRemembered={(memoryId) => {
                setTab("mine");
                setChanges((count) => count + 1);
                setPicked(memoryId);
              }}
            />
          }
          tabs={
            <Tabs
              onValueChange={(value) => {
                setTab(tabOf(value));
                setPicked(undefined);
              }}
              value={tab}
            >
              <TabsList aria-label={t`Memory`}>
                <TabsTrigger value="mine">
                  <Trans context="memory records: the person's own">
                    Yours
                  </Trans>
                </TabsTrigger>
                <TabsTrigger value="shared">
                  <Trans context="memory records: others' that you read">
                    Shared with you
                  </Trans>
                </TabsTrigger>
                <TabsTrigger value="lessons">
                  <Trans context="the Brain's lessons from repeated failures">
                    Lessons
                  </Trans>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          }
          title={t`Memory`}
        />
        {tab === "lessons" ? (
          <LessonsView admin={admin} />
        ) : (
          <div {...stylex.props(styles.split)}>
            <div {...stylex.props(styles.list)}>
              <RecordList
                among={tab}
                key={`${tab}:${changes}`}
                onPick={setPicked}
                picked={picked}
              />
            </div>
            {picked === undefined ? null : (
              <LineagePanel
                admin={admin}
                key={`${picked}:${changes}`}
                memoryId={picked}
                onChanged={(memoryId) => {
                  setChanges((count) => count + 1);
                  setPicked(memoryId);
                }}
                onClose={() => {
                  setPicked(undefined);
                }}
                onPick={setPicked}
                teams={teams}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
