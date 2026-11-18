import type { CatalogTool } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, Link } from "@tanstack/react-router";
import { useState } from "react";

import { formatDate } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import type { KeyValueItem } from "../grasp/key-value/index.ts";
import { PanelSection } from "../grasp/panel-section/index.ts";
import { Panel, PanelHeader, PanelView } from "../grasp/panel/index.ts";
import type { PanelLayoutStyle } from "../grasp/panel/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  canConnect,
  ConnectDialog,
  signInAgainTarget,
} from "./connect-dialog.tsx";
import { Disconnect } from "./connection-list.tsx";
import {
  aboutOf,
  allowedToolsOf,
  newestOf,
  toolGroups,
  useReaches,
  useWhyNoConnect,
} from "./integration-facts.ts";
import type { Integration } from "./integrations.ts";
import { stateOf } from "./integrations.ts";
import { ProviderMark } from "./provider-mark.tsx";
import { ToolRows } from "./tool-rows.tsx";
import { WorkflowsUsing } from "./workflows-using.tsx";
import type { ConnectionUses } from "./workflows-using.tsx";

// One app, opened beside the Integrations list, on Grasp UI's Panel (the
// Inspector pattern; its own Panel parts, as the head carries the app's
// own mark, which the Inspector panel's icon tile can't): its mark, name
// and what it is for; the one thing to do about it now (Connect, or Sign
// in again); where its account stands and who connected it; what Grasp may
// do in it, reads and changes, a few of each; the workflows that use it;
// and at its foot its own page, for everything rarely changed (each
// connection, who holds a permission for it, whether it is offered, which
// tools a connection allows), and Disconnect, red, where it has one
// connection this person may remove.

const styles = stylex.create({
  foot: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
});

/** Its tools, in their groups, once their read comes. */
const Tools = ({
  integration,
  tools,
}: {
  integration: Integration;
  tools: Promise<Loaded<CatalogTool[]>> | undefined;
}) => {
  const { i18n, t } = useLingui();
  const app = integration.name;
  if (tools === undefined) {
    return (
      <PanelSection label={t`What Grasp may do`}>
        <Empty size="inline">
          {t`The catalog doesn't list ${app}, so its tools can't be shown.`}
        </Empty>
      </PanelSection>
    );
  }
  const allowed = allowedToolsOf(integration);
  return (
    <Await
      fallback={
        <PanelSection label={t`What Grasp may do`}>
          <LoadingLines />
        </PanelSection>
      }
      promise={tools}
    >
      {(loaded) => {
        if (loaded.state !== "ready") {
          return (
            <PanelSection label={t`What Grasp may do`}>
              <Empty size="inline" tone="danger">
                {notLoadedText(loaded, i18n)}
              </Empty>
            </PanelSection>
          );
        }
        if (loaded.data.length === 0) {
          return (
            <PanelSection label={t`What Grasp may do`}>
              <Empty size="inline">{t`${app} has no tools.`}</Empty>
            </PanelSection>
          );
        }
        return toolGroups.map((group) => {
          const inGroup = loaded.data.filter(
            ({ readOnly }) => readOnly === group.readOnly
          );
          const label = i18n._(group.title);
          return inGroup.length === 0 ? null : (
            <PanelSection
              card={false}
              hint={t`What its tools do, as its provider declares them. Apps and agents use only what they are granted, and a tool that changes something waits for its person to confirm it.`}
              key={group.id}
              label={label}
            >
              <ToolRows
                allowed={allowed}
                label={label}
                slug={integration.id}
                tools={inGroup}
              />
            </PanelSection>
          );
        });
      }}
    </Await>
  );
};

/** Where its account stands: for whom, what it reaches, who connected it and when. */
const Account = ({
  integration,
  identity,
}: {
  integration: Integration;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const reachesOf = useReaches();
  const newest = newestOf(integration);
  if (newest === undefined) {
    return null;
  }
  const state = stateOf(integration);
  const by =
    newest.connectedBy === identity.userId
      ? t`You`
      : (newest.connectedByName ?? t`Someone no longer here`);
  const items: KeyValueItem[] = [
    {
      key: t`For`,
      value:
        state === "personal" ? t`Only you` : t`Everyone in the organization`,
    },
    { key: t`Reaches`, value: reachesOf(integration) },
    { key: t`Connected by`, value: by },
    { key: t`Connected on`, value: formatDate(newest.createdAt) },
  ];
  if (newest.accountName !== null) {
    items.unshift({ key: t`Account`, value: newest.accountName });
  }
  return (
    <PanelSection label={t`Account`}>
      <KeyValueList items={items} variant="inline" />
    </PanelSection>
  );
};

/** The one thing to do about it now, in the panel's bar: sign in again, or connect. */
const MainAction = ({
  integration,
  identity,
}: {
  integration: Integration;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const again = signInAgainTarget(integration, identity);
  const connects =
    integration.connections.length === 0 && canConnect(integration, identity);
  if (again === undefined && !connects) {
    return null;
  }
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
        size="xs"
        variant="ink"
      >
        {again === undefined ? t`Connect` : t`Sign in again`}
      </Button>
      <ConnectDialog
        {...(again === undefined ? {} : { again })}
        identity={identity}
        integration={integration}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
};

/** Its own page, and Disconnect where it has one connection this person may remove. */
const Foot = ({
  integration,
  identity,
}: {
  integration: Integration;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const { connections, name } = integration;
  const only = connections.length === 1 ? connections[0] : undefined;
  const removable =
    only !== undefined && (only.scope === "personal" || isAdmin(identity.role));
  return (
    <div {...stylex.props(styles.foot)}>
      <Button
        render={
          <Link
            params={{ integration: integration.key }}
            to="/integrations/$integration"
          />
        }
        size="sm"
        variant="quiet"
      >
        {t`All settings`}
      </Button>
      {removable ? (
        <Disconnect
          connection={only}
          label={
            only.accountName === null ? name : `${name} (${only.accountName})`
          }
          last={!integration.listed}
        />
      ) : null}
    </div>
  );
};

/** One app, beside the list (`framed`) or in a Sheet on a phone. */
export const IntegrationInspector = ({
  integration,
  identity,
  uses,
  tools,
  framed,
  onClose,
  layout,
}: {
  integration: Integration;
  identity: Identity;
  uses: ConnectionUses;
  /** Its tools, read when it opened; none for an app the catalog doesn't list. */
  tools: Promise<Loaded<CatalogTool[]>> | undefined;
  framed: boolean;
  onClose?: () => void;
  layout?: PanelLayoutStyle;
}) => {
  const { t } = useLingui();
  const whyNoConnectOf = useWhyNoConnect();
  const connected = integration.connections.length > 0;
  const why = connected ? undefined : whyNoConnectOf(integration, identity);
  const about = aboutOf(integration);
  const app = integration.name;
  return (
    <Panel
      aria-label={t`${app}, details`}
      framed={framed}
      {...(layout === undefined ? {} : { layout })}
    >
      <PanelHeader
        actions={<MainAction identity={identity} integration={integration} />}
        closeLabel={t`Close`}
        {...(about === undefined ? {} : { description: about })}
        icon={
          <ProviderMark
            id={integration.id}
            logo={integration.logo}
            name={integration.name}
            size="md"
          />
        }
        {...(onClose === undefined ? {} : { onClose })}
        title={integration.name}
      />
      <PanelView>
        {why === undefined ? null : <Alert title={why} />}
        <Account identity={identity} integration={integration} />
        <Tools
          integration={integration}
          tools={integration.listed ? tools : undefined}
        />
        {connected ? (
          <PanelSection card={false} label={t`Workflows`}>
            <WorkflowsUsing integration={integration} uses={uses} />
          </PanelSection>
        ) : null}
        <Foot identity={identity} integration={integration} />
      </PanelView>
    </Panel>
  );
};
