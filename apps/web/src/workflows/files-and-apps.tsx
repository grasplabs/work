import type {
  WorkflowFile,
  WorkflowKnowledge,
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
import type { ReactNode } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { stateOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import { formatBytes, formatDateTime, formatList } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import type { WorkflowApps } from "./workflow-apps.ts";

// A workflow's Files and apps (prototype `inside-files.tsx`,
// `inside-connectors.tsx`): the apps it works in, each with whether it is
// connected; the Knowledge it reads, with the names its bindings give it;
// and the files its runs wrote, what they are and never what they hold.
// Each part is read on its own and says on its own why it failed.

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

export const FilesAndApps = ({
  apps,
  knowledge,
  files,
}: {
  apps: Loaded<WorkflowApps>;
  knowledge: Loaded<WorkflowKnowledge[]>;
  files: Loaded<WorkflowFile[]>;
}) => (
  <div className="flex flex-col gap-8">
    <Section id="workflow-apps" title={<Trans>Apps it works in</Trans>}>
      {apps.state === "ready" ? (
        <Apps apps={apps.data} />
      ) : (
        <NotLoadedState page={apps} />
      )}
    </Section>
    <Section id="workflow-knowledge" title={<Trans>Knowledge it reads</Trans>}>
      {knowledge.state === "ready" ? (
        <Knowledge knowledge={knowledge.data} />
      ) : (
        <NotLoadedState page={knowledge} />
      )}
    </Section>
    <Section id="workflow-files" title={<Trans>Files its runs wrote</Trans>}>
      {files.state === "ready" ? (
        <Files files={files.data} />
      ) : (
        <NotLoadedState page={files} />
      )}
    </Section>
  </div>
);
