import type { AppIntegration } from "@grasp-os/shared/apps";
import { catalogEntryRefSchema } from "@grasp-os/shared/connect";
import type { CatalogEntryRef, OfferedCatalog } from "@grasp-os/shared/connect";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@grasp-os/ui/components/command";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, PlusIcon, XIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { AppLogo } from "../connections/app-logo.tsx";
import { integrationKey } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { WithInfo } from "../frame/info-tip.tsx";
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
    context: "why a connector is one of an App's",
  }),
  added: msg({
    message: "Added by hand",
    context: "why a connector is one of an App's",
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
      <PopoverTrigger asChild>
        <Button disabled={disabled} size="sm" variant="outline">
          <Icon icon={PlusIcon} />
          {t`Add a connector`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <Command
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
        >
          <CommandInput
            aria-label={t`Search connectors`}
            placeholder={t`Search connectors`}
          />
          <CommandEmpty>{t`No connectors match your search.`}</CommandEmpty>
          <CommandList />
        </Command>
      </PopoverContent>
    </Popover>
  );
};

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: space[3] },
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
    <Card size="sm" asChild>
      <section aria-label={t`Connectors`}>
        <CardHeader>
          <WithInfo
            of="title"
            info={t`Where the App’s data comes from. Those its code asks for are here by themselves; add any other it needs. Adding one connects nothing.`}
          >
            <CardTitle level={3}>{t`Connectors`}</CardTitle>
          </WithInfo>
          <CardAction>
            {builds ? (
              <AddPicker
                disabled={busy || catalog === null}
                entries={addable}
                onAdd={(entry) => {
                  change(async (api) => {
                    await api.add(app.id, refOf(entry));
                  });
                }}
              />
            ) : undefined}
          </CardAction>
        </CardHeader>
        <CardContent>
          <div {...stylex.props(styles.body)}>
            {lines.length === 0 ? (
              <Text size="sm" color="muted">
                {t`No connectors yet.`}
              </Text>
            ) : (
              <ItemGroup aria-label={t`Connectors`}>
                {lines.map((line, at) => {
                  const integrationName = line.name;
                  const addedOnly =
                    line.why.length === 1 && line.why[0] === "added";
                  return (
                    <Fragment key={line.key}>
                      {at === 0 ? null : <ItemSeparator />}
                      <Item size="xs">
                        <ItemMedia align="center">
                          <AppLogo
                            logo={line.logo}
                            name={line.name}
                            size="xs"
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
                              onClick={() => {
                                change(async (api) => {
                                  await api.remove(app.id, line.ref);
                                });
                              }}
                              size="icon-xs"
                              variant="ghost"
                            >
                              <Icon icon={XIcon} />
                            </Button>
                          ) : null}
                        </ItemActions>
                      </Item>
                    </Fragment>
                  );
                })}
              </ItemGroup>
            )}
            {builds && catalog === null ? (
              <Text size="sm" color="muted">
                {t`The catalog can’t be read right now, so nothing can be added. Try again in a moment.`}
              </Text>
            ) : null}
            {failure === undefined ? null : (
              <Alert variant="destructive">
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </section>
    </Card>
  );
};
