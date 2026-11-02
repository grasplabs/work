import type {
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
import { useEffect, useEffectEvent, useState } from "react";
import type { ReactNode } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { integrationsOf, stateOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { formatBytes, formatDateTime, formatList } from "../format.ts";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { workflowAppsOf } from "./workflow-apps.ts";
import type { WorkflowApps } from "./workflow-apps.ts";

// A workflow's Files and apps (prototype `inside-files.tsx`,
// `inside-connectors.tsx`): the apps it works in, each with whether it is
// connected; the Knowledge it reads, with the names its bindings give it;
// and the files its runs wrote, what they are and never what they hold.
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

/**
 * Files and apps of workflow `workflow`, read each time it is shown;
 * `versions` and `currentVersion` as the page read them.
 */
export const FilesAndApps = ({
  workflow,
  currentVersion,
  versions,
}: {
  workflow: string;
  currentVersion: number | null;
  versions: Loaded<WorkflowResourceVersion[]>;
}) => {
  const core = useCore();
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

  // The apps of the version as the page has it now, without reading again
  // for a page refresh that left the version where it was.
  const appsOfVersion = useEffectEvent(
    async (session: Session, version: number | null): Promise<WorkflowApps> =>
      await readApps(session, workflow, version, current)
  );

  // One rule for every part: read each time the tab opens, and again when
  // the current version moves (its bindings, so its apps, move with it).
  useEffect(() => {
    const left = new AbortController();
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
      void read(
        async (session) => await appsOfVersion(session, currentVersion),
        setApps
      );
    }
    return () => {
      left.abort();
    };
  }, [core, workflow, currentVersion, versionsRead]);

  return (
    <div className="flex flex-col gap-8">
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
