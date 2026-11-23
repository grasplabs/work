import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Icon, PlusIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { Fragment, useState } from "react";

import { AppMark } from "../app-mark.tsx";
import { SettingsCard } from "../settings-card.tsx";
import { AppsPicker } from "./apps-picker.tsx";
import { recommendedApps } from "./apps-recommend.ts";
import { toggled } from "./model.ts";
import type { CatalogApp, StepProps } from "./model.ts";
import { Question } from "./question.tsx";

// Which apps it may use (Ruben, 19 Nov 2026), drawn as the Integrations
// page lists apps (connections/overview-lists.tsx): a grouped card of
// slim rows, each app's mark, name and state, one quiet action at its end.
// First the apps on it, with Add connector in the card's head, which opens
// the whole catalog (apps-picker.tsx); then the ones that suit it,
// recommended from its job and name, each with Add. Core keeps no apps on an agent yet: grants are per
// chat (.context/core-needs.md, item 45).

/** What an app's row says under its name: connected as whom, or not yet. */
const useStanding = () => {
  const { t } = useLingui();
  return (app: CatalogApp): string => {
    if (!app.connected) {
      return t`Not connected yet`;
    }
    return app.account ?? t`Connected`;
  };
};

export const AppsStep = ({ setup, change, name, apps }: StepProps) => {
  const { t } = useLingui();
  const standing = useStanding();
  const [picking, setPicking] = useState(false);
  const recommended = recommendedApps(apps, setup, name);
  const chosen = apps.filter(({ id }) => setup.apps.has(id));
  const suggested = recommended.filter(({ id }) => !setup.apps.has(id));
  const put = (id: string, on: boolean) => {
    change({ apps: toggled(setup.apps, id, on) });
  };
  return (
    <Question
      line={
        recommended.length === 0
          ? t`Add the apps it works in.`
          : t`We picked the apps that fit. Add any other.`
      }
      title={t`Which apps can ${name} use?`}
    >
      {/* The apps on it, as the Integrations page lists apps: a grouped
          card, a slim row each, and Add connector at the end of its last row. */}
      <SettingsCard title={t`Apps ${name} can use`}>
        <ItemGroup>
          {chosen.map((app) => {
            const appName = app.name;
            return (
              <Fragment key={app.id}>
                <Item size="xs">
                  <ItemMedia>
                    <AppMark logo={app.logo} name={appName} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{appName}</ItemTitle>
                    <ItemDescription>{standing(app)}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={t`Remove ${appName}`}
                      onClick={() => {
                        put(app.id, false);
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      {t`Remove`}
                    </Button>
                  </ItemActions>
                </Item>
                <ItemSeparator />
              </Fragment>
            );
          })}
          {/* Its last row, as Linear's: where it stands at the start, Add
              connector at the end. */}
          <Item size="xs">
            <ItemContent>
              {chosen.length === 0 ? (
                <ItemDescription>{t`No apps added yet.`}</ItemDescription>
              ) : null}
            </ItemContent>
            <ItemActions>
              <Button
                onClick={() => {
                  setPicking(true);
                }}
                size="sm"
                variant="secondary"
              >
                <Icon icon={PlusIcon} />
                {t`Add connector`}
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsCard>
      {/* The ones that fit and aren't on it yet: Add moves one up. */}
      {suggested.length === 0 ? null : (
        <SettingsCard title={t`Recommended`}>
          <ItemGroup>
            {suggested.map((app, index) => {
              const appName = app.name;
              return (
                <Fragment key={app.id}>
                  {index === 0 ? null : <ItemSeparator />}
                  <Item size="xs">
                    <ItemMedia>
                      <AppMark logo={app.logo} name={appName} />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{appName}</ItemTitle>
                      <ItemDescription>
                        {app.description ?? standing(app)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        aria-label={t`Add ${appName}`}
                        onClick={() => {
                          put(app.id, true);
                        }}
                        size="sm"
                        variant="secondary"
                      >
                        <Icon icon={PlusIcon} />
                        {t`Add`}
                      </Button>
                    </ItemActions>
                  </Item>
                </Fragment>
              );
            })}
          </ItemGroup>
        </SettingsCard>
      )}
      {/* Mounted only while open, so it opens on the best app each time. */}
      {picking ? (
        <AppsPicker
          apps={apps}
          chosen={setup.apps}
          onOpenChange={setPicking}
          onToggle={put}
          open
          recommended={recommended}
        />
      ) : null}
    </Question>
  );
};
