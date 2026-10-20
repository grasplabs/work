import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  DownloadIcon,
  LayoutGridIcon,
  ListIcon,
  Rows3Icon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";

import { formatNumber } from "../format.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { AppMosaic } from "../landscape/app-mosaic.tsx";
import { AppTable } from "../landscape/app-table.tsx";
import type { Density } from "../landscape/app-table.tsx";
import { ColumnsMenu } from "../landscape/columns-menu.tsx";
import { ConnectLandscape } from "../landscape/connect-landscape.tsx";
import { downloadCsv, fileDate } from "../landscape/download.ts";
import { FilterMenu } from "../landscape/filter-menu.tsx";
import { loadLandscape } from "../landscape/landscape-data.ts";
import {
  defaultColumns,
  landscapeCsv,
  matchesLandscape,
  noFilters,
  parseLandscapeView,
  sortApps,
} from "../landscape/landscape.ts";
import type {
  Column,
  LandscapeApp,
  LandscapeFilters,
  LandscapeSort,
  LandscapeView,
} from "../landscape/landscape.ts";
import { hoverDelay, Toolbar, ToolbarLabel } from "../landscape/toolbar.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import { policyBook, policyToday } from "../policies/policies-data.ts";
import { applyPolicy, findings } from "../policies/policy.ts";

// The Landscape, as in the prototype (`routes/landscape/index.tsx`): every
// app the company uses, how Grasp knows about it, what data it touches and
// who owns it, as a table or a mosaic, to search, filter, sort and export.
// Its apps are those Grasp knows from its integrations
// (landscape/landscape-data.ts), marked by the company's policy rules. The
// prototype adds an app by hand and names its owner here; Grasp keeps
// neither yet, so the page has neither action.

type ToolbarMenu = "filter" | "layout" | "columns";

const LandscapePage = () => {
  const { t } = useLingui();
  const { apps: loaded, syncs } = Route.useLoaderData();
  const navigate = useNavigate();
  const view = Route.useSearch().view ?? "table";
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<LandscapeFilters>(noFilters);
  // One toolbar menu open at a time: hovering the next one closes the last, as in the V1 toolbar.
  const [menu, setMenu] = useState<ToolbarMenu | null>(null);
  const menuProps = (name: ToolbarMenu) => ({
    open: menu === name,
    onOpenChange: (open: boolean) => {
      setMenu((current) => {
        if (open) {
          return name;
        }
        return current === name ? null : current;
      });
    },
  });
  const [sort, setSort] = useState<LandscapeSort | null>(null);
  const [columns, setColumns] = useState<Column[]>(defaultColumns);
  const [density, setDensity] = useState<Density>("default");

  const raw: LandscapeApp[] = loaded.state === "ready" ? loaded.data : [];
  const apps = applyPolicy(
    raw,
    findings(policyBook.rules, raw, policyBook.exceptions, policyToday())
  );
  const shown = sortApps(
    apps.filter((app) => matchesLandscape(app, filters, query)),
    sort
  );
  const total = apps.length;
  const shownCount = formatNumber(shown.length);

  return (
    <>
      <SiteHeader crumbs={[{ label: t`Landscape` }]} />
      <Page wide>
        <PageHeading
          description={t`Every app your teams use: how Grasp knows about it, what data it touches and who owns it.`}
          title={t`Landscape`}
        />
        <NotLoaded page={loaded} />
        <ConnectLandscape syncs={syncs} />

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <InputGroup>
              <InputGroupInput
                aria-label={t`Search apps`}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder={t`Search apps`}
                value={query}
              />
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
            </InputGroup>
          </div>
          <span className="text-muted-foreground tabular-nums">
            {shown.length === total
              ? t`${plural(total, { one: "# app", other: "# apps" })}`
              : t`${plural(total, { one: `${shownCount} of # app`, other: `${shownCount} of # apps` })}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Toolbar label={t`Landscape tools`}>
              <FilterMenu
                apps={apps}
                filters={filters}
                onChange={setFilters}
                {...menuProps("filter")}
              />
              <DropdownMenu modal={false} {...menuProps("layout")}>
                <DropdownMenuTrigger
                  closeDelay={hoverDelay.close}
                  delay={hoverDelay.open}
                  openOnHover
                  render={<Button size="sm" variant="ghost" />}
                >
                  <Rows3Icon data-icon="inline-start" />
                  <ToolbarLabel>
                    <Trans>Layout</Trans>
                  </ToolbarLabel>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      <Trans context="how the landscape is shown">View</Trans>
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      onValueChange={(value: LandscapeView) => {
                        void navigate({
                          to: "/landscape",
                          search: value === "mosaic" ? { view: "mosaic" } : {},
                          replace: true,
                        });
                      }}
                      value={view}
                    >
                      <DropdownMenuRadioItem value="table">
                        <ListIcon />
                        <Trans>Table</Trans>
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="mosaic">
                        <LayoutGridIcon />
                        <Trans>Mosaic</Trans>
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                  {view === "table" ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>
                          <Trans>Row height</Trans>
                        </DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          onValueChange={(value: Density) => {
                            setDensity(value);
                          }}
                          value={density}
                        >
                          <DropdownMenuRadioItem value="compact">
                            <Trans context="row height">Compact</Trans>
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="default">
                            <Trans context="row height">Default</Trans>
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="comfortable">
                            <Trans context="row height">Comfortable</Trans>
                          </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuGroup>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              {view === "table" ? (
                <ColumnsMenu
                  columns={columns}
                  onChange={setColumns}
                  {...menuProps("columns")}
                />
              ) : null}
              <Button
                disabled={loaded.state !== "ready"}
                onClick={() => {
                  downloadCsv(
                    landscapeCsv(shown),
                    `landscape-${fileDate()}.csv`
                  );
                }}
                size="sm"
                variant="ghost"
              >
                <DownloadIcon data-icon="inline-start" />
                <ToolbarLabel>
                  <Trans>Export CSV</Trans>
                </ToolbarLabel>
              </Button>
            </Toolbar>
          </div>
        </div>

        {loaded.state === "ready" && view === "table" ? (
          <AppTable
            apps={shown}
            columns={columns}
            density={density}
            onSortChange={setSort}
            sort={sort}
          />
        ) : null}
        {loaded.state === "ready" && view === "mosaic" ? (
          <AppMosaic
            apps={shown}
            onOpen={(appId) => {
              void navigate({
                to: "/landscape/$appId/usage",
                params: { appId },
              });
            }}
          />
        ) : null}
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/landscape/")({
  validateSearch: (
    search: Record<string, unknown>
  ): { view?: LandscapeView } =>
    parseLandscapeView(search.view) === "mosaic" ? { view: "mosaic" } : {},
  // The view is in the address; the apps are read once.
  shouldReload: false,
  loader: async ({ context: { core, identity } }) =>
    await loadLandscape(core, identity),
  pendingComponent: PageLoading,
  component: LandscapePage,
});
