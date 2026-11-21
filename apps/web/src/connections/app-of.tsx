import { canSignInAgain } from "@grasp-os/shared/connect";
import type { CatalogTool, ListedConnection } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { formatDate } from "../format.ts";
import {
  appIntegrationWords,
  rollUp,
} from "../grasp/blocks/app-integration/app-integration.tsx";
import type {
  App,
  AppConnection,
  AppIntegrationWords,
} from "../grasp/blocks/app-integration/app-integration.tsx";
import { useWords } from "../grasp/words/words.tsx";
import { fixOf } from "./fix.ts";
import { groupLabel } from "./groups.ts";
import { aboutOf } from "./integration-facts.ts";
import type { Integration } from "./integrations.ts";
import { reliedOnLapsed, workflowsOf } from "./integrations.ts";
import { ProviderMark } from "./provider-mark.tsx";
import { appToolsOf } from "./tool-choices.ts";

// An integration as the library's app parts draw it (Grasp UI's
// app-integration block): its mark at the size the part shows it, what it
// is for, its tools and what Grasp may do with each, the connection the
// company relies on, and the workflows that use it. Where that
// connection stands comes from the one rule the header card, the tiles,
// the panel and the page share (`fixOf`): it works, this person can sign
// in to it again, or it has to be connected anew.

/**
 * The connection an app's parts speak of: the one the company relies on
 * when that lapsed, else the first that works, else the newest.
 */
const primaryOf = (
  integration: Integration,
  uses?: readonly ConnectionWorkflows[]
): ListedConnection | undefined => {
  const lapsed = integration.connections.find(
    ({ status }) => status === "needs_reauth"
  );
  if (lapsed !== undefined && reliedOnLapsed(integration, uses)) {
    return lapsed;
  }
  return (
    integration.connections.find(({ status }) => status === "active") ??
    integration.connections[0]
  );
};

/** How a connection stands for the parts: it works, sign in again, or connect it anew. */
const appStateOf = (
  connection: ListedConnection,
  integration: Integration,
  identity: Pick<Identity, "role" | "staff">
): AppConnection["state"] => {
  if (connection.status === "active") {
    return "works";
  }
  return fixOf(integration, identity) === "sign-in" ? "sign-in" : "reconnect";
};

/**
 * How one account stands on its own row, as its own buttons do: it works,
 * this person signs in to it again, or it is connected anew.
 */
const rowStateOf = (
  connection: ListedConnection,
  integration: Integration,
  identity: Pick<Identity, "role" | "staff">
): AppConnection["state"] => {
  if (connection.status === "active") {
    return "works";
  }
  return canSignInAgain(connection, integration.offered, identity)
    ? "sign-in"
    : "reconnect";
};

/** A promise's value once it settles, for as long as it is the promise given; undefined until then. */
export const useSettled = <T,>(
  promise: Promise<T> | undefined
): T | undefined => {
  const [settled, setSettled] = useState<{ promise: Promise<T>; value: T }>();
  useEffect(() => {
    let live = true;
    const settle = async (given: Promise<T>): Promise<void> => {
      const value = await given;
      if (live) {
        setSettled({ promise: given, value });
      }
    };
    if (promise !== undefined) {
      void settle(promise);
    }
    return () => {
      live = false;
    };
  }, [promise]);
  return settled?.promise === promise ? settled?.value : undefined;
};

/** What an app's parts are given besides the integration. */
interface AppOptions {
  /** Its tools, once read; none before, or for an app the catalog doesn't list. */
  tools?: readonly CatalogTool[] | undefined;
  /** Which workflows use each connection, once read. */
  uses?: readonly ConnectionWorkflows[] | undefined;
  /** The mark's size: `sm` on a tile, `md` in the panel, `lg` on the page. */
  size: "sm" | "md" | "lg";
}

/** The parts' App for an integration, in this person's words. */
export const useAppOf = (
  identity: Pick<Identity, "role" | "staff" | "userId">
) => {
  const { t } = useLingui();
  return (integration: Integration, { tools, uses, size }: AppOptions): App => {
    const primary = primaryOf(integration, uses);
    // Each account, in its own state: the page's rows.
    const rows = integration.connections.map((each): AppConnection => ({
      id: each.id,
      account: each.accountName ?? integration.name,
      ...(each.accountName === null ? {} : { signedInAs: each.accountName }),
      forWhom: each.scope === "shared" ? "everyone" : "you",
      by:
        each.connectedBy === identity.userId
          ? t`You`
          : (each.connectedByName ?? t`Someone no longer here`),
      on: formatDate(each.createdAt),
      state: rowStateOf(each, integration, identity),
    }));
    const row = rows.find(({ id }) => id === primary?.id);
    // The one the company relies on, when it ran out, says how to fix it
    // (`fixOf`); else every account counts: one that ran out beside one that
    // works needs someone.
    const connection: AppConnection | undefined =
      row === undefined || primary === undefined
        ? undefined
        : {
            ...row,
            state:
              primary.status === "active"
                ? (rollUp(rows.map(({ state }) => state)) ?? row.state)
                : appStateOf(primary, integration, identity),
          };
    const workflows =
      uses === undefined
        ? undefined
        : workflowsOf(integration, uses).map((workflow) => ({
            name: workflow.name,
            kind: "workflow" as const,
            href: `/workflows/${encodeURIComponent(workflow.id)}`,
          }));
    return {
      id: integration.key,
      name: integration.name,
      mark: (
        <ProviderMark
          id={integration.id}
          logo={integration.logo}
          name={integration.name}
          size={size}
        />
      ),
      ...(integration.logo === null ? {} : { markSrc: integration.logo }),
      description: aboutOf(integration) ?? "",
      ...(tools === undefined
        ? {}
        : {
            tools: appToolsOf(
              tools,
              integration,
              primary,
              t`No longer offered`
            ),
          }),
      ...(integration.toolCount === undefined
        ? {}
        : { toolCount: integration.toolCount }),
      ...(connection === undefined ? {} : { connection }),
      ...(rows.length === 0 ? {} : { connections: rows }),
      ...(workflows === undefined ? {} : { workflows }),
    };
  };
};

/**
 * A tile's own words, where its one fact says more than the part's: a
 * hidden app is not offered; one without a tool count is of its kind; a
 * Composio app says how many of its tools its admin allowed; and an app
 * that stopped working which this person can't connect again waits for an
 * admin.
 */
export const useTileWords = (identity: Pick<Identity, "role" | "staff">) => {
  const { t, i18n } = useLingui();
  const words = useWords("appIntegration", appIntegrationWords);
  return (
    integration: Integration,
    uses?: readonly ConnectionWorkflows[]
  ): Partial<AppIntegrationWords> => {
    const primary = primaryOf(integration, uses);
    if (primary === undefined) {
      if (integration.listed && !integration.offered) {
        return { tools: () => t`Not offered` };
      }
      return integration.toolCount === undefined
        ? { tools: () => i18n._(groupLabel[integration.group]) }
        : {};
    }
    if (
      primary.status === "needs_reauth" &&
      fixOf(integration, identity) === "none"
    ) {
      return { needsConnect: t`Waiting for an admin` };
    }
    const allowed = primary.offeredTools ?? primary.tools;
    return integration.source === "composio" &&
      allowed !== undefined &&
      integration.toolCount !== undefined
      ? { works: words.allowed(allowed.length, integration.toolCount) }
      : {};
  };
};
