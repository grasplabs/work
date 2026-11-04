import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import type {
  PendingWorkflowBindings,
  ListedWorkflowBindingApproval,
  WorkflowBindingTarget,
  WorkflowFile,
  WorkflowKnowledge,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Confirmed } from "../confirmed.tsx";
import { AppLogo } from "../connections/app-logo.tsx";
import { integrationsOf, stateOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatBytes, formatDateTime, formatList } from "../format.ts";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
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

const Section = ({
  id,
  title,
  children,
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
}) => (
  <section aria-labelledby={id} className="flex flex-col gap-3">
    <h2 className="font-medium" id={id}>
      {title}
    </h2>
    {children}
  </section>
);

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
    {children}
  </p>
);

/** How a connected app stands, in words. */
const ConnectedState = ({ integration }: { integration: Integration }) => {
  const state = stateOf(integration);
  if (state === "needs_reauth") {
    return (
      <Badge variant="destructive">
        <Trans>Needs someone to sign in again</Trans>
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <Trans context="state of one app">Connected</Trans>
    </Badge>
  );
};

const Apps = ({ apps }: { apps: WorkflowApps }) => {
  if (apps.connected.length === 0 && apps.unconnected.length === 0) {
    return (
      <Quiet>
        <Trans>It works in no app.</Trans>
      </Quiet>
    );
  }
  return (
    <ul className="bg-card flex flex-col divide-y rounded-xl border">
      {apps.connected.map((integration) => (
        <li className="flex items-center gap-3 px-4 py-3" key={integration.key}>
          <AppLogo logo={integration.logo} name={integration.name} size="sm" />
          <Link
            className="min-w-0 flex-1 truncate font-medium hover:underline focus-visible:underline"
            params={{ integration: integration.key }}
            to="/integrations/$integration"
          >
            {integration.name}
          </Link>
          <ConnectedState integration={integration} />
        </li>
      ))}
      {apps.unconnected.map(({ alias, contractId }) => (
        <li className="flex items-center gap-3 px-4 py-3" key={alias}>
          <AppLogo logo={null} name={alias} size="sm" />
          <span className="flex min-w-0 flex-1 flex-col">
            <code className="truncate font-medium">{alias}</code>
            {contractId === null ? null : (
              <span className="text-muted-foreground truncate">
                {contractId}
              </span>
            )}
          </span>
          <Badge variant="outline">
            <Trans>Not connected</Trans>
          </Badge>
        </li>
      ))}
    </ul>
  );
};

const Knowledge = ({ knowledge }: { knowledge: WorkflowKnowledge[] }) => {
  const { t } = useLingui();
  if (knowledge.length === 0) {
    return (
      <Quiet>
        <Trans>It reads no Knowledge.</Trans>
      </Quiet>
    );
  }
  return (
    <ul className="bg-card flex flex-col divide-y rounded-xl border">
      {knowledge.map((collection) => {
        const aliases = formatList(collection.aliases);
        return (
          <li
            className="flex flex-col gap-1 px-4 py-3"
            key={collection.collectionId}
          >
            <Link
              className="font-medium hover:underline focus-visible:underline"
              params={{ collection: collection.collectionId }}
              to="/knowledge/$collection"
            >
              {collection.name}
            </Link>
            <span className="text-muted-foreground">
              {collection.aliases.length === 0
                ? t`No version uses it yet`
                : t`Its versions call it ${aliases}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
};

const Files = ({ files }: { files: WorkflowFile[] }) => {
  const { t } = useLingui();
  if (files.length === 0) {
    return (
      <Quiet>
        <Trans>Its runs have written no file you may see.</Trans>
      </Quiet>
    );
  }
  return (
    <div className="bg-card overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead variant="card">{t`Name`}</TableHead>
            <TableHead variant="card">{t`Type`}</TableHead>
            <TableHead variant="card">{t`Size`}</TableHead>
            <TableHead variant="card">{t`Written`}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => (
            <TableRow key={file.id}>
              <TableCell variant="roomy">{file.name}</TableCell>
              <TableCell variant="roomy">{file.type}</TableCell>
              <TableCell variant="roomy">{formatBytes(file.size)}</TableCell>
              <TableCell variant="roomy">
                {formatDateTime(file.writtenAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        <Trans>
          It can&apos;t start until you approve what each binding reaches, for
          the version it runs.
        </Trans>
      </p>
      {pending.map(({ version, live, bindings }) => (
        <div className="flex flex-col gap-2" key={version}>
          <h3 className="font-medium">
            {live ? (
              <Trans>Version {version}, which runs now</Trans>
            ) : (
              <Trans>Version {version}, not live yet</Trans>
            )}
          </h3>
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
  // Its catalog bindings: whichever other workflow a binding names is
  // hidden from all but its builders, so known by kind alone.
  const catalog = declared.filter(({ kind }) => kind !== "workflow");
  if (catalog.length === 0) {
    return (
      <Quiet>
        <Trans>Version {version} declares no binding to approve.</Trans>
      </Quiet>
    );
  }
  const revoke = async (alias: string, approval: string): Promise<void> => {
    onSaid();
    const revoked = await run(async (session) => {
      await session.workflowResources.revokeBinding(workflow, approval);
      return true;
    });
    if (revoked === true) {
      onSaid(t`Revoked: ${alias}.`);
      onChanged();
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">
        <Trans>Version {version}, which runs now</Trans>
      </h3>
      <ul
        aria-label={t`Bindings of version ${version}`}
        className="flex flex-col gap-2"
      >
        {catalog.map(({ alias, kind, contractId, fingerprint }) => {
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
                  <Badge variant="outline">
                    <Trans>Waiting for an admin&apos;s approval</Trans>
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 flex-col gap-1">
                  <span>
                    {targetWords(approval.target, approval.label, {
                      people: names.people,
                      teams,
                    })}
                  </span>
                  <span className="text-muted-foreground">
                    <Trans>
                      Approved by {approver} on {at}
                    </Trans>
                  </span>
                </span>
                {revokes ? (
                  <Confirmed
                    busy={busy}
                    button={t`Revoke`}
                    confirm={t`Revoke`}
                    description={t`Its next start is refused until an admin approves ${alias} again, and runs already started fail at their next call through it.`}
                    label={t`Revoke ${alias}`}
                    onConfirm={() => {
                      void revoke(alias, approval.id);
                    }}
                    title={t`Revoke ${alias}?`}
                  />
                ) : null}
              </div>
            </BindingFrame>
          );
        })}
      </ul>
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
    return <LoadingLines />;
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
      async (session) => await session.workflows.teams(),
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
    <div className="flex flex-col gap-8">
      {pending === undefined ||
      (pending.state === "ready" && pending.data.length === 0) ? null : (
        <Section
          id="workflow-waiting"
          title={<Trans>Waiting for your approval</Trans>}
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
        <Section id="workflow-bindings" title={<Trans>Its bindings</Trans>}>
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
      <Section id="workflow-apps" title={<Trans>Apps it works in</Trans>}>
        <Part loaded={appsOf}>{(data) => <Apps apps={data} />}</Part>
      </Section>
      <Section
        id="workflow-knowledge"
        title={<Trans>Knowledge it reads</Trans>}
      >
        <Part loaded={knowledge}>
          {(data) => <Knowledge knowledge={data} />}
        </Part>
      </Section>
      <Section id="workflow-files" title={<Trans>Files its runs wrote</Trans>}>
        <Part loaded={files}>{(data) => <Files files={data} />}</Part>
      </Section>
    </div>
  );
};
