import type { CatalogTool, ListedConnection } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Button } from "../grasp/button/index.ts";
import { Search as SearchIcon } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { RowAlert, SettingsRows } from "../grasp/setting-row/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Integration } from "./integrations.ts";
import { ToolChoice } from "./tool-choice.tsx";
import { toolRules, withAllowed, withRead } from "./tool-choices.ts";
import type { AllowedTool } from "./tool-choices.ts";
import { toolWords } from "./tool-rows.tsx";
import { useChange } from "./use-change.ts";

/** How many tools show at first, besides every tool it allows. */
const firstShown = 8;

const styles = stylex.create({
  search: { marginInline: grasp.space4, marginBlockStart: grasp.space3 },
  more: { marginInline: grasp.space3, marginBlock: grasp.space2 },
  // A group's name in the card's flush rows, on their inset.
  head: {
    marginInline: grasp.space4,
    marginBlockStart: grasp.space3,
    marginBlockEnd: grasp.space1,
  },
});

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
}[] = [
  { id: "read", readOnly: true, title: msg`Reads` },
  { id: "change", readOnly: false, title: msg`Changes` },
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
    <Item size="xs">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={t`Remove ${name}`}
          disabled={disabled}
          onClick={onRemove}
          size="sm"
          variant="ghost"
        >
          {t`Remove`}
        </Button>
      </ItemActions>
    </Item>
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
  const { i18n, t } = useLingui();
  const { busy, failure, change } = useChange();
  const [search, setSearch] = useState("");
  const [all, setAll] = useState(false);
  const allowed = allowedOf(connection);
  const allowedNames = new Set(allowed.map(({ name }) => name));
  const wanted = search.trim().toLowerCase();
  // What the search finds, by the tool's plain words or its description;
  // the tools it allows first, then the rest, each in Composio's order.
  const found = tools
    .filter(
      (tool) =>
        wanted === "" ||
        toolWords(tool.name, connection.provider)
          .toLowerCase()
          .includes(wanted) ||
        (tool.description ?? "").toLowerCase().includes(wanted)
    )
    .toSorted(
      (one, other) =>
        Number(allowedNames.has(other.name)) -
        Number(allowedNames.has(one.name))
    );
  // Every tool it allows shows, and a few more, until someone asks for all
  // or searches: an app can have hundreds.
  const shown =
    all || wanted !== ""
      ? found
      : found.filter(
          (tool, index) => allowedNames.has(tool.name) || index < firstShown
        );
  const total = found.length;
  const hidden = total - shown.length;
  const offered = new Set(tools.map(({ name }) => name));
  const gone = allowed.filter(({ name }) => !offered.has(name));
  const save = (next: AllowedTool[]): void => {
    void change(async (session) => {
      await session.connections.changeTools({
        connectionId: connection.id,
        tools: toolRules(next),
        // What this page shows: a change since makes it refused, and the
        // page is read again (`useChange`).
        expected: toolRules(allowed),
      });
    });
  };
  return (
    <>
      <SettingsRows>
        <RowAlert variant="neutral">
          {t`Read tools run without asking. Write tools wait for the person to confirm. Mark a tool Read only if it changes nothing.`}
        </RowAlert>
        {failure === undefined ? null : (
          <RowAlert variant="danger">{failure}</RowAlert>
        )}
      </SettingsRows>
      <div {...stylex.props(styles.search)}>
        <InputGroup>
          <InputGroupText icon={SearchIcon} />
          <InputGroupInput
            aria-label={t`Search tools`}
            onValueChange={setSearch}
            placeholder={t`Search tools`}
            type="search"
            value={search}
          />
          <InputGroupClear aria-label={t`Clear search`} />
        </InputGroup>
      </div>
      {groups.map((group) => {
        const inGroup = shown.filter(
          ({ readOnly }) => readOnly === group.readOnly
        );
        const title = i18n._(group.title);
        return inGroup.length === 0 ? null : (
          <section key={group.id}>
            <SectionHeader layout={styles.head} size="sm" title={title} />
            <ItemGroup aria-label={title} separated>
              {inGroup.map((tool) => (
                <ToolChoice
                  app={connection.provider}
                  choice={allowed.find(({ name }) => name === tool.name)}
                  disabled={busy || staff}
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
            </ItemGroup>
          </section>
        );
      })}
      {hidden > 0 ? (
        <Button
          layout={styles.more}
          onClick={() => {
            setAll(true);
          }}
          size="sm"
          variant="ghost"
        >
          {t`${plural(total, { one: "Show the # tool", other: "Show all # tools" })}`}
        </Button>
      ) : null}
      {wanted !== "" && found.length === 0 ? (
        <SettingsRows>
          <RowAlert variant="neutral">{t`No tools match your search.`}</RowAlert>
        </SettingsRows>
      ) : null}
      {gone.length === 0 ? null : (
        <section>
          <SectionHeader
            layout={styles.head}
            size="sm"
            title={t`No longer offered`}
          />
          <ItemGroup aria-label={t`No longer offered`} separated>
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
          </ItemGroup>
        </section>
      )}
    </>
  );
};
