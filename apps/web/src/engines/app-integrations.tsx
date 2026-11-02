import type { AppIntegration } from "@grasp-os/shared/apps";
import { catalogEntryRefSchema } from "@grasp-os/shared/connect";
import type { CatalogEntryRef, OfferedCatalog } from "@grasp-os/shared/connect";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@grasp-os/ui/components/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { AppLogo } from "../connections/app-logo.tsx";
import { integrationKey } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { SettingsBody, SettingsSection } from "../settings/settings-parts.tsx";
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
    context: "why an integration is one of a domain's",
  }),
  added: msg({
    message: "Added by hand",
    context: "why an integration is one of a domain's",
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
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        disabled={disabled}
        render={<Button size="sm" variant="outline" />}
      >
        <PlusIcon data-icon="inline-start" />
        <Trans>Add an integration</Trans>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72" variant="flush">
        <Command
          filter={(value: string, search: string) =>
            value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder={t`Search integrations`} />
          <CommandList>
            <CommandEmpty>
              <Trans>No integrations match your search.</Trans>
            </CommandEmpty>
            {entries.map((entry) => (
              <CommandItem
                key={integrationKey(entry.source, entry.id)}
                onSelect={() => {
                  setOpen(false);
                  onAdd(entry);
                }}
                value={`${entry.name} ${entry.categories.join(" ")}`}
              >
                <AppLogo logo={entry.logo} name={entry.name} size="xs" />
                <span className="flex-1 truncate">{entry.name}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

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
    <SettingsSection
      action={
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
      description={t`Where the domain’s data comes from. Those its code asks for are here by themselves; add any other it needs. Adding one connects nothing.`}
      title={t`Integrations`}
    >
      <SettingsBody>
        {lines.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>No integrations yet.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {lines.map((line) => {
              const integrationName = line.name;
              const addedOnly =
                line.why.length === 1 && line.why[0] === "added";
              return (
                <li
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0"
                  key={line.key}
                >
                  <AppLogo logo={line.logo} name={line.name} size="xs" />
                  <span className="min-w-0 flex-1 basis-40 truncate font-medium">
                    {integrationName}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {line.why.map((why) => (
                      <Badge key={why} variant="outline">
                        {i18n._(whyNames[why])}
                      </Badge>
                    ))}
                  </span>
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
                      <XIcon />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {builds && catalog === null ? (
          <p className="text-muted-foreground">
            <Trans>
              The catalog can’t be read right now, so nothing can be added. Try
              again in a moment.
            </Trans>
          </p>
        ) : null}
        <ErrorText>{failure}</ErrorText>
      </SettingsBody>
    </SettingsSection>
  );
};
