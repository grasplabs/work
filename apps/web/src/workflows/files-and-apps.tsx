import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import type {
  PendingWorkflowBindings,
  ListedWorkflowBindingApproval,
  WorkflowBindingTarget,
  WorkflowFile,
  WorkflowKnowledge,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";

import { integrationsOf, stateOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import { ProviderMark } from "../connections/provider-mark.tsx";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatBytes, formatDateTime, formatList } from "../format.ts";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
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
import { Empty } from "../grasp/empty/index.ts";
import { Brain, Cable } from "../grasp/icons/index.ts";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import type { Names } from "./activity-bar.tsx";
import {
  BindingFrame,
  PendingBindingList,
  targetWords,
} from "./binding-approvals.tsx";
import { workflowAppsOf } from "./workflow-apps.ts";
import type { WorkflowApps } from "./workflow-apps.ts";

// A workflow's Files and apps (prototype `inside-files.tsx`,
// `inside-connectors.tsx`): for the organization's admins, what it reaches
// that waits for their approval, approved here, as a start refused for it
// says; each catalog binding of the version a start runs now, with what an
// admin approved it to reach, who and when, which the organization's
// admins revoke here (the binding then waits again, its starts are refused
// and runs already started fail at their next call through it); the apps
// it works in, each with whether it is connected; the Knowledge it reads,
// with the names its bindings give it; and the files its runs wrote, what
// they are and never what they hold.
// Each part is read on its own, each time the tab opens, and says on its
// own why it failed: the apps read the catalog and connections from
// connect (a cold catalog can take seconds), which no other tab needs, so
// the page never waits for them.

const styles = stylex.create({
  tab: { display: "flex", flexDirection: "column", gap: grasp.space6 },
  versions: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  version: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  // A part's own words and lists inside its card.
  inset: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
  },
  approved: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  approvedWords: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    minWidth: 0,
  },
  loading: { padding: grasp.space4 },
});

/** One part of the tab, on a card of its own under its title. */
const Section = ({
  title,
  flush = false,
  description,
  children,
}: {
  title: string;
  flush?: boolean;
  description?: string;
  children: ReactNode;
}) => (
  <SectionCard
    density="compact"
    flush={flush}
    title={title}
    {...(description === undefined ? {} : { description })}
  >
    {children}
  </SectionCard>
);

/** How a connected app stands, in words: a badge only when it needs someone. */
const ConnectedState = ({ integration }: { integration: Integration }) => {
  const { t } = useLingui();
  const state = stateOf(integration);
  if (state === "needs_reauth") {
    return (
      <Badge size="sm" tone="attention">
        {t`Needs someone to sign in again`}
      </Badge>
    );
  }
  return (
    <Badge size="sm" tone="success">
      {t({ message: "Connected", context: "state of one app" })}
    </Badge>
  );
};

const Apps = ({ apps }: { apps: WorkflowApps }) => {
  const { t } = useLingui();
  if (apps.connected.length === 0 && apps.unconnected.length === 0) {
    return <Empty size="inline">{t`It works in no app.`}</Empty>;
  }
  return (
    <ItemGroup separated>
      {apps.connected.map((integration) => (
        <Item
          key={integration.key}
          render={
            <Link
              params={{ integration: integration.key }}
              to="/integrations/$integration"
            />
          }
          size="xs"
        >
          <ItemMedia>
            <ProviderMark
              id={integration.id}
              logo={integration.logo}
              name={integration.name}
            />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{integration.name}</ItemTitle>
          </ItemContent>
          <ItemActions>
            <ConnectedState integration={integration} />
          </ItemActions>
        </Item>
      ))}
      {apps.unconnected.map(({ alias, contractId }) => (
        <Item key={alias} size="xs">
          <ItemMedia icon={Cable} iconLook="inline" />
          <ItemContent>
            <ItemTitle>
              <code>{alias}</code>
            </ItemTitle>
            <ItemDescription>{contractId}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Badge size="sm" tone="attention">{t`Not connected`}</Badge>
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
};

const Knowledge = ({ knowledge }: { knowledge: WorkflowKnowledge[] }) => {
  const { t } = useLingui();
  if (knowledge.length === 0) {
    return <Empty size="inline">{t`It reads no Knowledge.`}</Empty>;
  }
  return (
    <ItemGroup separated>
      {knowledge.map((collection) => {
        const aliases = formatList(collection.aliases);
        return (
          <Item
            key={collection.collectionId}
            render={
              <Link
                params={{ collection: collection.collectionId }}
                to="/knowledge/$collection"
              />
            }
            size="xs"
          >
            <ItemMedia icon={Brain} iconLook="inline" />
            <ItemContent>
              <ItemTitle>{collection.name}</ItemTitle>
              <ItemDescription>
                {collection.aliases.length === 0
                  ? t`No version uses it yet`
                  : t`Its versions call it ${aliases}`}
              </ItemDescription>
            </ItemContent>
          </Item>
        );
      })}
    </ItemGroup>
  );
};

const Files = ({ files }: { files: WorkflowFile[] }) => {
  const { t } = useLingui();
  if (files.length === 0) {
    return (
      <Empty size="inline">{t`Its runs have written no file you may see.`}</Empty>
    );
  }
  return (
    <Table aria-label={t`Files its runs wrote`}>
      <TableHeader>
        <TableRow>
          <TableHead>{t`Name`}</TableHead>
          <TableHead>{t`Type`}</TableHead>
          <TableHead>{t`Size`}</TableHead>
          <TableHead>{t`Written`}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => (
          <TableRow key={file.id}>
            <TableCell>{file.name}</TableCell>
            <TableCell>{file.type}</TableCell>
            <TableCell>{formatBytes(file.size)}</TableCell>
            <TableCell>{formatDateTime(file.writtenAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/**
 * The versions of workflow `workflow` whose bindings wait, each binding
 * approved for its version; `onApproved` with the binding once one is.
 * What was approved is said by the tab, not here: approving the last one
 * leaves nothing waiting, and this part goes with it.
 */
const Waiting = ({
  workflow,
  pending,
  onApproving,
  onApproved,
}: {
  workflow: string;
  pending: readonly PendingWorkflowBindings[];
  onApproving: () => void;
  onApproved: (alias: string) => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  const approve =
    (version: number) =>
    async (alias: string, target: WorkflowBindingTarget): Promise<void> => {
      onApproving();
      const approved = await run(async (session) => {
        await session.workflowResources.approveBinding(workflow, {
          alias,
          target,
          reviewed: { version },
        });
        return true;
      });
      if (approved === true) {
        onApproved(alias);
      }
    };
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.versions)}>
      {pending.map(({ version, live, bindings }) => (
        <div key={version} {...stylex.props(styles.version)}>
          <Text element="p" size="sm" weight="medium">
            {live
              ? t`Version ${version}, which runs now`
              : t`Version ${version}, not live yet`}
          </Text>
          <PendingBindingList
            bindings={bindings}
            busy={busy}
            onApprove={approve(version)}
          />
        </div>
      ))}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/**
 * Each catalog binding of version `version`, `declared`, with the approval
 * of `approvals` that serves it, if any: what it reaches (a decision's
 * deciders by `names` and `teams`), who approved it and when, and, when
 * `revokes`, Revoke; `onChanged` once one is revoked.
 */
const Approved = ({
  workflow,
  version,
  declared,
  approvals,
  names,
  teams,
  revokes,
  onSaid,
  onChanged,
}: {
  workflow: string;
  version: number;
  declared: WorkflowResourceVersion["bindings"];
  approvals: readonly ListedWorkflowBindingApproval[];
  names: Names;
  teams: ReadonlyMap<string, string>;
  revokes: boolean;
  /** What was done last, which the tab says, or nothing once another starts. */
  onSaid: (said?: string) => void;
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  if (declared.length === 0) {
    return (
      <Empty size="inline">{t`Version ${version} declares no binding to approve.`}</Empty>
    );
  }
  const revoke = async (alias: string, approval: string): Promise<void> => {
    onSaid();
    const revoked = await run(async (session) => {
      await session.workflowResources.revokeBinding(workflow, approval);
      return true;
    });
    if (revoked !== true) {
      // The dialog stays open; why is said under the bindings.
      throw new Error("It wasn't revoked.");
    }
    onSaid(t`Revoked: ${alias}.`);
    onChanged();
  };
  return (
    <div {...stylex.props(styles.version)}>
      <Text element="p" size="sm" weight="medium">
        {t`Version ${version}, which runs now`}
      </Text>
      <ItemGroup aria-label={t`Bindings of version ${version}`}>
        {declared.map(({ alias, kind, contractId, fingerprint }) => {
          // Served as a start serves it: approved for this version's own
          // declaration of the alias (its contract's fingerprint, as the
          // key itself is shown to its builders alone).
          const approval = approvals.find(
            (each) =>
              each.reviewedVersion === version &&
              each.alias === alias &&
              each.kind === kind &&
              each.fingerprint === fingerprint
          );
          if (approval === undefined) {
            return (
              <BindingFrame
                alias={alias}
                contractId={contractId}
                key={alias}
                kind={kind}
              >
                <span>
                  <Badge size="sm" tone="attention">
                    {t`Waiting for an admin's approval`}
                  </Badge>
                </span>
              </BindingFrame>
            );
          }
          const approver =
            names.people.get(approval.approvedBy) ?? approval.approvedBy;
          const at = formatDateTime(approval.approvedAt);
          return (
            <BindingFrame
              alias={alias}
              contractId={approval.contractId}
              key={alias}
              kind={kind}
            >
              <div {...stylex.props(styles.approved)}>
                <span {...stylex.props(styles.approvedWords)}>
                  <span>
                    {targetWords(approval.target, approval.label, {
                      people: names.people,
                      teams,
                    })}
                  </span>
                  <Text element="span" size="sm" tone="muted">
                    {t`Approved by ${approver} on ${at}`}
                  </Text>
                </span>
                {revokes ? (
                  <AlertDialog>
                    <AlertDialogTrigger
                      aria-label={t`Revoke ${alias}`}
                      disabled={busy}
                      size="sm"
                      variant="quiet"
                    >
                      {t`Revoke`}
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogTitle>{t`Revoke ${alias}?`}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t`Its next start is refused until an admin approves ${alias} again, and runs already started fail at their next call through it.`}
                      </AlertDialogDescription>
                      <AlertDialogFooter>
                        <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
                        <AlertDialogAction
                          action={async () => {
                            await revoke(alias, approval.id);
                          }}
                          failedLabel={t`Not revoked`}
                          variant="danger"
                        >
                          {t`Revoke`}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </div>
            </BindingFrame>
          );
        })}
      </ItemGroup>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** A part of the tab: loading until read, then its content or why not. */
const Part = <T,>({
  loaded,
  children,
}: {
  loaded: Loaded<T> | undefined;
  children: (data: T) => ReactNode;
}): ReactNode => {
  if (loaded === undefined) {
    return (
      <div {...stylex.props(styles.loading)}>
        <LoadingLines />
      </div>
    );
  }
  return loaded.state === "ready" ? (
    children(loaded.data)
  ) : (
    <NotLoadedState page={loaded} />
  );
};

/**
 * The apps workflow `workflow` works in: the catalog and the connections
 * Integrations reads, which of them serve it, and the connector bindings
 * of `current`, the version the page already read, that nothing serves yet.
 */
const readApps = async (
  session: Session,
  workflow: string,
  currentVersion: number | null,
  current: WorkflowResourceVersion | undefined
): Promise<WorkflowApps> => {
  const [catalog, connections, uses, approvals] = await Promise.all([
    session.connections.catalog(),
    session.connections.list(),
    session.workflows.byConnection(),
    session.workflowResources.bindings(workflow),
  ]);
  return workflowAppsOf({
    workflow,
    integrations: integrationsOf(catalog.entries, connections),
    uses,
    currentVersion,
    bindings: current?.bindings ?? [],
    approvals,
  });
};

/** The catalog bindings of the version a start runs now, and its approvals. */
interface RunningBindings {
  version: number;
  declared: WorkflowResourceVersion["bindings"];
  approvals: ListedWorkflowBindingApproval[];
}

/**
 * What `RunningBindings` the reads give, once all are read: of the version
 * a start runs now, as core picks it for what waits (`pendingBindingsOf`),
 * the live one, or before any went live `currentVersion`, the one published
 * last; null before any was published.
 */
const runningBindingsOf = (
  versions: Loaded<WorkflowResourceVersion[]>,
  lifecycle: Loaded<WorkflowLifecycle>,
  currentVersion: number | null,
  approvals: Loaded<ListedWorkflowBindingApproval[]> | undefined
): Loaded<RunningBindings | null> | undefined => {
  if (versions.state !== "ready") {
    return versions;
  }
  if (lifecycle.state !== "ready") {
    return lifecycle;
  }
  if (approvals?.state !== "ready") {
    return approvals;
  }
  const version = lifecycle.data.live?.version ?? currentVersion;
  const running = versions.data.find((each) => each.version === version);
  return {
    state: "ready",
    data:
      version === null || running === undefined
        ? null
        : { version, declared: running.bindings, approvals: approvals.data },
  };
};

/**
 * Files and apps of workflow `workflow`, read each time it is shown;
 * `versions`, `currentVersion` and `lifecycle` as the page read them, and
 * `names` who approved its bindings. `approves` for one of the
 * organization's admins, who approve and revoke its bindings here.
 */
export const FilesAndApps = ({
  workflow,
  currentVersion,
  versions,
  lifecycle,
  names,
  approves,
}: {
  workflow: string;
  currentVersion: number | null;
  versions: Loaded<WorkflowResourceVersion[]>;
  lifecycle: Loaded<WorkflowLifecycle>;
  names: Names;
  approves: boolean;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [pending, setPending] = useState<Loaded<PendingWorkflowBindings[]>>();
  const [approvals, setApprovals] =
    useState<Loaded<ListedWorkflowBindingApproval[]>>();
  const [teams, setTeams] = useState<ReadonlyMap<string, string>>(new Map());
  // What was approved or revoked last, said by the tab, once: even after
  // the last binding waiting is approved and its section goes.
  const [said, setSaid] = useState<string>();
  const [apps, setApps] = useState<Loaded<WorkflowApps>>();
  const [knowledge, setKnowledge] = useState<Loaded<WorkflowKnowledge[]>>();
  const [files, setFiles] = useState<Loaded<WorkflowFile[]>>();
  // Without the versions, which bindings it declares isn't known.
  const versionsRead = versions.state === "ready";
  const current = versionsRead
    ? versions.data.find(({ version }) => version === currentVersion)
    : undefined;
  const appsOf: Loaded<WorkflowApps> | undefined = versionsRead
    ? apps
    : versions;
  const runningBindings = runningBindingsOf(
    versions,
    lifecycle,
    currentVersion,
    approvals
  );

  // The apps of the version as the page has it now, without reading again
  // for a page refresh that left the version where it was.
  const appsOfVersion = useEffectEvent(
    async (session: Session, version: number | null): Promise<WorkflowApps> =>
      await readApps(session, workflow, version, current)
  );

  // One rule for every part: read each time the tab opens, and again when
  // the current version moves (its bindings, so its apps, move with it).
  const rereads = useRef(0);
  useEffect(() => {
    const left = new AbortController();
    // A read started now, whose answer any later read supersedes: an
    // approval's, or this effect's next.
    rereads.current += 1;
    const started = rereads.current;
    const latest = async <T,>(
      part: (session: Session) => Promise<T>,
      set: (loaded: Loaded<T>) => void
    ): Promise<void> => {
      const loaded = await loadFromCore(core, part, left.signal);
      if (!left.signal.aborted && started === rereads.current) {
        set(loaded);
      }
    };
    const read = async <T,>(
      part: (session: Session) => Promise<T>,
      set: (loaded: Loaded<T>) => void
    ): Promise<void> => {
      const loaded = await loadFromCore(core, part, left.signal);
      if (!left.signal.aborted) {
        set(loaded);
      }
    };
    void read(
      async (session) => await session.workflowResources.knowledge(workflow),
      setKnowledge
    );
    void read(
      async (session) => await session.workflowResources.files(workflow),
      setFiles
    );
    if (versionsRead) {
      void latest(
        async (session) => await appsOfVersion(session, currentVersion),
        setApps
      );
    }
    void latest(
      async (session) => await session.workflowResources.bindings(workflow),
      setApprovals
    );
    // The teams a decision's deciders may name, for its builders and the
    // organization's admins: anyone else, or a read that fails, sees IDs.
    void read(
      async (session) => await session.organization.teams(),
      (loaded) => {
        if (loaded.state === "ready") {
          setTeams(new Map(loaded.data.map(({ id, name }) => [id, name])));
        }
      }
    );
    if (approves) {
      void latest(
        async (session) =>
          await session.workflowResources.pendingBindingsOf(workflow),
        setPending
      );
    }
    return () => {
      left.abort();
    };
  }, [core, workflow, currentVersion, versionsRead, approves]);

  // Once a binding is approved or revoked: what waits and what is
  // approved, read again and shown as soon as they land, and the apps its
  // approvals connect, apart. Only the latest of each read is shown, the
  // tab's first reads among them, as one started before a later change
  // would miss it.
  const changed = async (): Promise<void> => {
    rereads.current += 1;
    const reread = rereads.current;
    const latest = (): boolean => reread === rereads.current;
    const waiting = approves
      ? loadFromCore(
          core,
          async (session) =>
            await session.workflowResources.pendingBindingsOf(workflow)
        )
      : undefined;
    const approved = loadFromCore(
      core,
      async (session) => await session.workflowResources.bindings(workflow)
    );
    const connected = versionsRead
      ? loadFromCore(
          core,
          async (session) =>
            await readApps(session, workflow, currentVersion, current)
        )
      : undefined;
    const waited = await waiting;
    if (waited !== undefined && latest()) {
      setPending(waited);
    }
    const approvedRead = await approved;
    if (latest()) {
      setApprovals(approvedRead);
    }
    const appsRead = await connected;
    if (appsRead !== undefined && latest()) {
      setApps(appsRead);
    }
  };

  return (
    <div {...stylex.props(styles.tab)}>
      {pending === undefined ||
      (pending.state === "ready" && pending.data.length === 0) ? null : (
        <Section
          description={t`It can't start until you approve what each binding reaches, for the version it runs.`}
          title={t`Waiting for your approval`}
        >
          <Part loaded={pending}>
            {(data) => (
              <Waiting
                onApproved={(alias) => {
                  setSaid(t`Approved: ${alias}.`);
                  void changed();
                }}
                onApproving={() => {
                  setSaid(undefined);
                }}
                pending={data}
                workflow={workflow}
              />
            )}
          </Part>
        </Section>
      )}
      {said === undefined ? null : <output>{said}</output>}
      {runningBindings?.state === "ready" &&
      runningBindings.data === null ? null : (
        <Section title={t`Its bindings`}>
          <Part loaded={runningBindings}>
            {(data) =>
              data === null ? null : (
                <Approved
                  approvals={data.approvals}
                  declared={data.declared}
                  names={names}
                  teams={teams}
                  onChanged={() => {
                    void changed();
                  }}
                  onSaid={setSaid}
                  revokes={approves}
                  version={data.version}
                  workflow={workflow}
                />
              )
            }
          </Part>
        </Section>
      )}
      <Section flush title={t`Apps it works in`}>
        <Part loaded={appsOf}>{(data) => <Apps apps={data} />}</Part>
      </Section>
      <Section flush title={t`Knowledge it reads`}>
        <Part loaded={knowledge}>
          {(data) => <Knowledge knowledge={data} />}
        </Part>
      </Section>
      <Section flush title={t`Files its runs wrote`}>
        <Part loaded={files}>{(data) => <Files files={data} />}</Part>
      </Section>
    </div>
  );
};
