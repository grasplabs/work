import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { ProviderMark } from "../../connections/provider-mark.tsx";
import { Badge } from "../../grasp/badge/index.ts";
import { Button } from "../../grasp/button/index.ts";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
} from "../../grasp/dialog/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "../../grasp/empty/index.ts";
import { Heading } from "../../grasp/heading/index.ts";
import { Plus, Search, Tick } from "../../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../../grasp/input-group/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../grasp/item/index.ts";
import { ScrollArea } from "../../grasp/scroll-area/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import type { CatalogApp } from "./model.ts";

// The connector picker of New agent's apps step (apps-step.tsx), after
// Linear's (Ruben, 19 Nov 2026): a search field over the company's whole
// catalog on the start side, in three parts (recommended for this agent,
// connected, and every other app by name), and the app pointed at on the
// end side: its mark, its name, what it does, and one action, Add, which
// puts it on the agent. An app not connected yet can still be added: it
// is connected on the agent's page or under Integrations.

const styles = stylex.create({
  // The list and the detail side by side; one above the other when narrow.
  panes: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 20rem) minmax(0, 1fr)",
      "@media (width < 48rem)": "minmax(0, 1fr)",
    },
    gap: grasp.space6,
    minHeight: "28rem",
  },
  side: { display: "grid", alignContent: "start", gap: grasp.space3 },
  list: { height: "26rem" },
  part: { display: "grid", gap: grasp.space1, paddingBlockEnd: grasp.space4 },
  detail: { display: "grid", alignContent: "start", gap: grasp.space4 },
  head: { display: "flex", alignItems: "center", gap: grasp.space3 },
  facts: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  action: { justifySelf: "start" },
});

/** One part of the list: its name and its apps, each a row that shows it on the end side. */
const Part = ({
  title,
  apps,
  shown,
  chosen,
  onShow,
}: {
  title: string;
  apps: readonly CatalogApp[];
  shown: string | undefined;
  chosen: ReadonlySet<string>;
  onShow: (id: string) => void;
}) => {
  const { t } = useLingui();
  if (apps.length === 0) {
    return null;
  }
  return (
    <div {...stylex.props(styles.part)}>
      <Text size="sm" tone="muted">
        {title}
      </Text>
      <ItemGroup>
        {apps.map((app) => (
          <Item
            current={app.id === shown}
            key={app.id}
            render={
              <button
                aria-label={app.name}
                onClick={() => {
                  onShow(app.id);
                }}
                type="button"
              />
            }
            size="xs"
          >
            <ItemMedia>
              <ProviderMark
                id={app.id}
                logo={app.logo}
                name={app.name}
                size="sm"
              />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{app.name}</ItemTitle>
              {chosen.has(app.id) ? (
                <ItemDescription>{t`Added`}</ItemDescription>
              ) : null}
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
};

/** The app pointed at: what it is, and Add. */
const Detail = ({
  app,
  added,
  onToggle,
}: {
  app: CatalogApp;
  added: boolean;
  onToggle: (on: boolean) => void;
}) => {
  const { t } = useLingui();
  const { name, account } = app;
  // Whom it is connected as, or that it can be connected later.
  const connectedAs =
    account === null ? undefined : t`Connected as ${account}.`;
  const standing = app.connected
    ? connectedAs
    : t`You can add it now and connect it after the agent is made.`;
  return (
    <div {...stylex.props(styles.detail)}>
      <div {...stylex.props(styles.head)}>
        <ProviderMark id={app.id} logo={app.logo} name={name} size="md" />
        <Heading level={3} size="md">
          {name}
        </Heading>
      </div>
      <div {...stylex.props(styles.facts)}>
        {app.connected ? (
          <Badge tone="success">{t`Connected`}</Badge>
        ) : (
          <Badge tone="neutral">{t`Not connected yet`}</Badge>
        )}
        {app.categories.map((category) => (
          <Badge key={category} tone="neutral">
            {category}
          </Badge>
        ))}
      </div>
      {app.description === null ? null : <Text>{app.description}</Text>}
      {standing === undefined ? null : (
        <Text size="sm" tone="muted">
          {standing}
        </Text>
      )}
      <Button
        icon={added ? Tick : Plus}
        layout={styles.action}
        onClick={() => {
          onToggle(!added);
        }}
        variant={added ? "quiet" : "ink"}
      >
        {added ? t`Added` : t`Add ${name}`}
      </Button>
    </div>
  );
};

/** The connector picker: see the file's head. */
export const AppsPicker = ({
  open,
  onOpenChange,
  apps,
  recommended,
  chosen,
  onToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The company's whole catalog. */
  apps: readonly CatalogApp[];
  /** The apps that suit this agent, the best first. */
  recommended: readonly CatalogApp[];
  /** The apps on the agent, by catalog id. */
  chosen: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<string | undefined>(recommended.at(0)?.id);
  const asked = query.trim().toLowerCase();
  const matches = apps.filter(
    (app) =>
      asked === "" ||
      app.name.toLowerCase().includes(asked) ||
      app.categories.some((category) => category.toLowerCase().includes(asked))
  );
  const recommendedIds = new Set(recommended.map(({ id }) => id));
  const recommendedShown = matches.filter(({ id }) => recommendedIds.has(id));
  const connectedShown = matches.filter(
    ({ id, connected }) => connected && !recommendedIds.has(id)
  );
  const othersShown = matches
    .filter(({ id, connected }) => !connected && !recommendedIds.has(id))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const app =
    apps.find(({ id }) => id === shown) ?? matches.at(0) ?? apps.at(0);
  return (
    <Dialog onOpenChange={onOpenChange} open={open} size="full">
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Add a connector`}</DialogTitle>
        <DialogBody>
          <div {...stylex.props(styles.panes)}>
            <div {...stylex.props(styles.side)}>
              <InputGroup>
                <InputGroupText icon={Search} />
                <InputGroupInput
                  aria-label={t`Search apps`}
                  onValueChange={(value: string) => {
                    setQuery(value);
                  }}
                  placeholder={t`Search…`}
                  type="search"
                  value={query}
                />
                <InputGroupClear aria-label={t`Clear search`} />
              </InputGroup>
              <ScrollArea aria-label={t`Apps`} layout={styles.list}>
                {matches.length === 0 ? (
                  <Empty size="sm">
                    <EmptyHeader>
                      <EmptyDescription>{t`No app by that name.`}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <>
                    <Part
                      apps={recommendedShown}
                      chosen={chosen}
                      onShow={setShown}
                      shown={app?.id}
                      title={t`Recommended`}
                    />
                    <Part
                      apps={connectedShown}
                      chosen={chosen}
                      onShow={setShown}
                      shown={app?.id}
                      title={t`Connected`}
                    />
                    <Part
                      apps={othersShown}
                      chosen={chosen}
                      onShow={setShown}
                      shown={app?.id}
                      title={t`All apps`}
                    />
                  </>
                )}
              </ScrollArea>
            </div>
            {app === undefined ? null : (
              <Detail
                added={chosen.has(app.id)}
                app={app}
                onToggle={(on) => {
                  onToggle(app.id, on);
                }}
              />
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
