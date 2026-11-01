import type { CatalogTool, ListedConnection } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { CircleSlashIcon, EyeIcon, PenLineIcon } from "lucide-react";

import { ErrorText } from "../error-text.tsx";
import type { Integration } from "./integrations.ts";
import { ToolChoice } from "./tool-choice.tsx";
import { toolRules, withAllowed, withRead } from "./tool-choices.ts";
import type { AllowedTool } from "./tool-choices.ts";
import { useChange } from "./use-change.ts";

// Changing what Grasp may do in a connected app from its page (GRA-993), as
// the prototype's permission list (`components/connection-permissions.tsx`):
// each tool with its switch and the dialog's Read or Write badge. Each change
// goes to core at once (connect checks the role and the tools, and audits
// it), and the page is read again. Only a shared Composio connection's tools
// can change: a native connector's are fixed.

/**
 * The connection whose tools `identity` may change on `integration`'s page:
 * its active shared Composio connection, for an admin. Grasp's staff see
 * the switches, but connect leaves the choice to the client's admins.
 */
export const changeableConnectionOf = (
  integration: Integration,
  identity: Identity
): ListedConnection | undefined =>
  isAdmin(identity.role) && integration.source === "composio"
    ? integration.connections.find(
        ({ scope, status, tools }) =>
          scope === "shared" && status === "active" && tools !== undefined
      )
    : undefined;

/**
 * What `connection` allows now, each tool with whether it only reads and
 * the resource property its rule names, so a change keeps it.
 */
export const allowedOf = (connection: ListedConnection): AllowedTool[] =>
  (connection.tools ?? []).map((name) => {
    const resource = connection.toolResources?.[name];
    return {
      name,
      read: connection.readTools?.includes(name) ?? false,
      ...(resource === undefined ? {} : { resource }),
    };
  });

const groups: readonly {
  id: string;
  readOnly: boolean;
  title: MessageDescriptor;
  icon: typeof EyeIcon;
}[] = [
  { id: "read", readOnly: true, title: msg`Reads`, icon: EyeIcon },
  { id: "change", readOnly: false, title: msg`Changes`, icon: PenLineIcon },
];

/**
 * A tool `connection` allows that its toolkit no longer offers: it can
 * only be removed (connect refuses adding a tool the toolkit lacks, but
 * keeps one already allowed).
 */
const NoLongerOffered = ({
  name,
  disabled,
  onRemove,
}: {
  name: string;
  disabled: boolean;
  onRemove: () => void;
}) => {
  const { t } = useLingui();
  return (
    <li className="flex min-h-11 items-center gap-2 border-b px-3 py-2 last:border-b-0">
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        {name}
      </span>
      <Button
        aria-label={t`Remove ${name}`}
        disabled={disabled}
        onClick={onRemove}
        size="sm"
        variant="outline"
      >
        <Trans>Remove</Trans>
      </Button>
    </li>
  );
};

/**
 * An admin's switches for which of `tools` `connection` allows, and which
 * of those only read; one it allows that `tools` no longer has, to remove.
 * The last tool allowed can't be switched off: a connection allows at
 * least one (disconnect it instead).
 */
export const ToolPermissions = ({
  tools,
  connection,
  staff,
}: {
  tools: readonly CatalogTool[];
  connection: ListedConnection;
  staff: boolean;
}) => {
  const { i18n } = useLingui();
  const { busy, failure, change } = useChange();
  const allowed = allowedOf(connection);
  const offered = new Set(tools.map(({ name }) => name));
  const gone = allowed.filter(({ name }) => !offered.has(name));
  const save = (next: AllowedTool[]): void => {
    void change(async (session) => {
      await session.connections.changeTools({
        connectionId: connection.id,
        tools: toolRules(next),
      });
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        <Trans>
          A Read tool runs without asking. A call of a Write tool from chat, or
          from a person using a domain, waits for that person to confirm it.
          Press a tool&apos;s badge to change it. Mark a tool Read only if it
          changes nothing: marked wrongly, it changes things without asking.
        </Trans>
      </p>
      {groups.map((group) => {
        const inGroup = tools.filter(
          ({ readOnly }) => readOnly === group.readOnly
        );
        const { icon: Icon } = group;
        return inGroup.length === 0 ? null : (
          <div className="flex flex-col gap-2" key={group.id}>
            <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
              <Icon aria-hidden="true" className="size-3.5" />
              {i18n._(group.title)}
            </h3>
            <ul className="bg-card flex flex-col overflow-hidden rounded-xl border">
              {inGroup.map((tool) => (
                <ToolChoice
                  choice={allowed.find(({ name }) => name === tool.name)}
                  disabled={busy || staff}
                  idPrefix="integration-tool"
                  key={tool.name}
                  locked={allowed.length === 1}
                  onAllow={(allow) => {
                    save(withAllowed(allowed, tool, allow));
                  }}
                  onRead={(read) => {
                    save(withRead(allowed, tool.name, read));
                  }}
                  tool={tool}
                />
              ))}
            </ul>
          </div>
        );
      })}
      {gone.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <CircleSlashIcon aria-hidden="true" className="size-3.5" />
            <Trans>No longer offered</Trans>
          </h3>
          <ul className="bg-card flex flex-col overflow-hidden rounded-xl border">
            {gone.map(({ name }) => (
              <NoLongerOffered
                disabled={busy || staff || allowed.length === 1}
                key={name}
                name={name}
                onRemove={() => {
                  save(allowed.filter((tool) => tool.name !== name));
                }}
              />
            ))}
          </ul>
        </div>
      )}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
