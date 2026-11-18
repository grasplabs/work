import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { Badge } from "../grasp/badge/index.ts";
import { CommandDialog } from "../grasp/command/index.ts";
import type { CommandEntry, CommandItems } from "../grasp/command/index.ts";
import { Plus } from "../grasp/icons/index.ts";
import { groupLabel } from "./groups.ts";
import type { Integration } from "./integrations.ts";
import { find, stateOf } from "./integrations.ts";
import { AppMark } from "./overview-lists.tsx";

// Finding an app, and asking for one Grasp can't reach yet, in one place
// (Ruben, 18 Nov 2026: "the request app should be a search and if it's
// not there they can request"): the library's command palette. Typing
// ranks the apps already connected, then those that can be added, each by
// its mark, with where it stands; whatever is typed is also offered as a
// request, last, so nobody asks for an app that is here and nobody hunts
// for a way to ask. An app opens beside the list; a request goes on to its
// link and reason (request-app-dialog.tsx), the name already given.

/** The request row's value: no app's key has no colon. */
const REQUEST = "request";

/** An app as a row of the palette. */
const useRow = () => {
  const { t, i18n } = useLingui();
  return (integration: Integration): CommandEntry => {
    const kind = i18n._(groupLabel[integration.group]);
    const needs = stateOf(integration) === "needs_reauth";
    return {
      value: integration.key,
      label: integration.name,
      media: <AppMark integration={integration} />,
      description: integration.description ?? kind,
      ...(needs
        ? {
            end: (
              <Badge size="sm" tone="attention">
                {t`Needs sign-in`}
              </Badge>
            ),
          }
        : {}),
      ...(!needs && !integration.offered && integration.connections.length === 0
        ? { end: <Badge size="sm">{t`Not offered`}</Badge> }
        : {}),
    };
  };
};

/**
 * The palette: open while `open`; picking an app hands its key to
 * `onApp`, asking for what was typed hands the name to `onRequest`.
 */
export const FindApp = ({
  integrations,
  open,
  onOpenChange,
  onApp,
  onRequest,
}: {
  integrations: readonly Integration[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApp: (key: string) => void;
  onRequest: (name: string) => void;
}) => {
  const { t } = useLingui();
  const rowOf = useRow();
  const [query, setQuery] = useState("");
  const sought = query.trim();
  // The palette's order is the page's: the apps here first, then those to
  // add, the request always last, however well its words match.
  const found = find(integrations, sought);
  const connected = found.filter((each) => each.connections.length > 0);
  const others = found.filter((each) => each.connections.length === 0);
  const items: CommandItems = [
    ...(connected.length === 0
      ? []
      : [
          {
            type: "group" as const,
            label: t({
              message: "Connected",
              context: "apps that are connected",
            }),
            items: connected.map(rowOf),
          },
        ]),
    ...(others.length === 0
      ? []
      : [
          {
            type: "group" as const,
            label: t({
              message: "Add an app",
              context: "apps that can still be connected",
            }),
            items: others.map(rowOf),
          },
        ]),
    ...(sought === ""
      ? []
      : [
          {
            type: "group" as const,
            label: t`Not here?`,
            items: [
              {
                value: REQUEST,
                label: t`Request ${sought}`,
                icon: Plus,
                description: t`Grasp checks what it takes to connect it.`,
              },
            ],
          },
        ]),
  ];
  return (
    <CommandDialog
      aria-label={t`Find an app`}
      empty={t`Type the app's name to request it.`}
      filter={false}
      items={items}
      onAction={(value) => {
        if (value === REQUEST) {
          onRequest(sought);
        } else {
          onApp(value);
        }
        return true;
      }}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
        }
        onOpenChange(next);
      }}
      onQueryChange={setQuery}
      open={open}
      placeholder={t`Find an app, or name one to request`}
      query={query}
      shortcut={null}
      trigger={null}
    />
  );
};
