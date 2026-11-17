import type { AppIntegration } from "@grasp-os/shared/apps";
import { catalogEntryRefSchema } from "@grasp-os/shared/connect";
import type { CatalogEntryRef, OfferedCatalog } from "@grasp-os/shared/connect";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { integrationKey } from "../connections/integrations.ts";
import { ProviderMark } from "../connections/provider-mark.tsx";
import type { Session } from "../core.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Command } from "../grasp/command/index.ts";
import { Cross, Plus } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";

// An App's integrations, on its settings page (grasplabs/prototype
// `components/apps/app-settings.tsx`, Integrations): those it holds a
// permission on a connection to, which its code asked for, and those its
// builders added by hand for what it needs besides. Adding one grants and
// connects nothing (core's `apps.integrations`, audited): it is what the
// App is shown with until its code asks for it. Only one added by hand,
// and held for no other reason, can be taken off here.

type Entry = OfferedCatalog["entries"][number];

const whyNames = {
  permission: msg({
    message: "Its code uses it",
    context: "why an integration is one of an App's",
  }),
  added: msg({
    message: "Added by hand",
    context: "why an integration is one of an App's",
  }),
} as const;

/** One integration as a line: its name and logo from the catalog, if listed. */
interface Line {
  key: string;
  ref: CatalogEntryRef;
  name: string;
  logo: string | null;
  why: AppIntegration["why"];
}

/** A catalog entry's reference, as core takes it. */
const refOf = (entry: Pick<Entry, "source" | "id">): CatalogEntryRef =>
  catalogEntryRefSchema.parse({ source: entry.source, id: entry.id });

/** The catalog entries the App doesn't have yet, to add one from. */
const AddPicker = ({
  entries,
  disabled,
  onAdd,
}: {
  entries: readonly Entry[];
  disabled: boolean;
  onAdd: (entry: Entry) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const byKey = new Map(
    entries.map((entry) => [integrationKey(entry.source, entry.id), entry])
  );
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger disabled={disabled} icon={Plus} size="sm">
        {t`Add an integration`}
      </PopoverTrigger>
      <PopoverContent align="end">
        <Command
          aria-label={t`Search integrations`}
          bare
          empty={t`No integrations match your search.`}
          items={entries.map((entry) => ({
            value: integrationKey(entry.source, entry.id),
            label: entry.name,
            keywords: [...entry.categories],
          }))}
          onAction={(value) => {
            const entry = byKey.get(value);
            setOpen(false);
            if (entry !== undefined) {
              onAdd(entry);
            }
          }}
          placeholder={t`Search integrations`}
        />
      </PopoverContent>
    </Popover>
  );
};

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: grasp.space3 },
});

/**
 * The App's integrations, and, for its builders, adding one by hand and
 * taking one added by hand off. `catalog` names them; an entry it doesn't
 * list shows by its ID, and while it can't be read (null) every one does.
 */
export const AppIntegrations = ({
  app,
  integrations,
  catalog,
  builds,
}: {
  app: { id: string; name: string };
  integrations: readonly AppIntegration[];
  /** Null while the catalog can't be read: nothing can be added then. */
  catalog: readonly Entry[] | null;
  builds: boolean;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const byKey = new Map(
    (catalog ?? []).map((entry) => [
      integrationKey(entry.source, entry.id),
      entry,
    ])
  );
  const lines: Line[] = integrations.map((integration) => {
    const key = integrationKey(integration.source, integration.id);
    const entry = byKey.get(key);
    return {
      key,
      ref: { source: integration.source, id: integration.id },
      name: entry?.name ?? integration.id,
      logo: entry?.logo ?? null,
      why: integration.why,
    };
  });
  const listed = new Set(lines.map(({ key }) => key));
  // What may be added: what is offered and the App doesn't have yet.
  const addable = (catalog ?? []).filter(
    (entry) =>
      entry.offered && !listed.has(integrationKey(entry.source, entry.id))
  );
  const change = (
    act: (api: Session["apps"]["integrations"]) => Promise<void>
  ): void => {
    void run(async (session) => {
      await changeThenRefresh(
        async () => {
          await act(session.apps.integrations);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const appName = app.name;
  return (
    <SectionCard
      actions={
        builds ? (
          <AddPicker
            disabled={busy || catalog === null}
            entries={addable}
            onAdd={(entry) => {
              change(async (api) => {
                await api.add(app.id, refOf(entry));
              });
            }}
          />
        ) : undefined
      }
      density="compact"
      headingLevel={3}
      info={t`Where the App’s data comes from. Those its code asks for are here by themselves; add any other it needs. Adding one connects nothing.`}
      title={t`Integrations`}
    >
      <div {...stylex.props(styles.body)}>
        {lines.length === 0 ? (
          <Text size="sm" tone="muted">
            {t`No integrations yet.`}
          </Text>
        ) : (
          <ItemGroup aria-label={t`Integrations`} separated>
            {lines.map((line) => {
              const integrationName = line.name;
              const addedOnly =
                line.why.length === 1 && line.why[0] === "added";
              return (
                <Item key={line.key} size="xs">
                  <ItemMedia>
                    <ProviderMark
                      id={line.ref.id}
                      logo={line.logo}
                      name={line.name}
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{integrationName}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    {line.why.map((why) => (
                      <Badge key={why}>{i18n._(whyNames[why])}</Badge>
                    ))}
                    {builds && addedOnly ? (
                      <Button
                        aria-label={t`Take ${integrationName} off ${appName}`}
                        disabled={busy}
                        icon={Cross}
                        onClick={() => {
                          change(async (api) => {
                            await api.remove(app.id, line.ref);
                          });
                        }}
                        size="xs"
                        variant="ghost"
                      />
                    ) : null}
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        )}
        {builds && catalog === null ? (
          <Text size="sm" tone="muted">
            {t`The catalog can’t be read right now, so nothing can be added. Try again in a moment.`}
          </Text>
        ) : null}
        {failure === undefined ? null : <Alert tone="danger">{failure}</Alert>}
      </div>
    </SectionCard>
  );
};
