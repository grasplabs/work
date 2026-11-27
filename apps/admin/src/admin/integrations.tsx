/**
 * The apps the companies asked Grasp to add, as Composio's catalog doesn't
 * have them, for every organization at once (`askedApps`): each app once,
 * with who asked for it and when. A row opens it (`?app=`), listing each
 * company that asked with a link to its integrations.
 */
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink, useNavigate } from "@tanstack/react-router";

import type { ClientAdmin } from "../clients/admin.ts";
import { AdminsLoading, WithAdmins } from "./admins.tsx";
import { DataRows } from "./data-rows.tsx";
import type { DataColumn, RowLook } from "./data-rows.tsx";
import { askedApps } from "./integrations-asked.ts";
import type { AskedApp } from "./integrations-asked.ts";
import { AdminPage } from "./page.tsx";
import type { Deferred } from "./settled.tsx";
import { formatDate, formatList } from "./words.ts";

const styles = stylex.create({
  cell: { display: "flex", flexDirection: "column", gap: space["1"] },
});

/** The companies that asked for an app, by name. */
const askedByOf = (app: AskedApp): string =>
  formatList(app.asks.map((ask) => ask.orgName));

/** Who asked for an app, over when it was first asked for. */
const AskedBy = ({ app }: { app: AskedApp }) => (
  <span {...stylex.props(styles.cell)}>
    <span>{askedByOf(app)}</span>
    <Text as="span" color="muted" size="xs">
      {`First asked on ${formatDate(app.asks[0]?.on ?? "")}`}
    </Text>
  </span>
);

const appColumns: DataColumn<AskedApp>[] = [
  {
    id: "asked",
    head: "Asked by",
    cell: (app) => <AskedBy app={app} />,
    wrap: true,
  },
];

/** A row and a card open the app in its sheet. */
const appLink = (app: AskedApp, look: RowLook) => (
  <RouterLink
    {...look}
    aria-label={`Open ${app.name}`}
    search={{ app: app.key }}
    to="/connectors"
  />
);

const appName = (app: AskedApp): string => app.name;

const appKeyOf = (app: AskedApp): string => app.key;

/** Every app asked for, one row each (a card on a phone), the one most asked for first. */
const AppTable = ({ apps }: { apps: readonly AskedApp[] }) => (
  <DataRows
    columns={appColumns}
    label="Apps asked for"
    link={appLink}
    name={appName}
    nameHead="App"
    rowKey={appKeyOf}
    rows={apps}
  />
);

/** The app open in its sheet, when `open` names one asked for: each company that asked. */
const AppSheet = ({
  apps,
  open,
}: {
  apps: readonly AskedApp[];
  open: string | undefined;
}) => {
  const navigate = useNavigate({ from: "/connectors" });
  const shown = apps.find((app) => app.key === open);
  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) {
          void navigate({ search: {}, replace: true });
        }
      }}
      open={shown !== undefined}
    >
      <SheetContent size="lg">
        {shown === undefined ? null : (
          <>
            <SheetHeader>
              <SheetTitle>{shown.name}</SheetTitle>
              <SheetDescription>Who asked for it, and when.</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <ItemGroup>
                {shown.asks.map((ask) => (
                  <Item key={ask.org} size="sm">
                    <ItemContent>
                      <ItemTitle>
                        <Link asChild variant="plain">
                          <RouterLink
                            params={{ clientId: ask.org }}
                            to="/organizations/$clientId/connectors"
                          >
                            {ask.orgName}
                          </RouterLink>
                        </Link>
                      </ItemTitle>
                      <ItemDescription>{`Asked on ${formatDate(ask.on)}`}</ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
};

/** Where the table goes, while nothing is asked for. */
const NothingAsked = () => (
  <Empty>
    <EmptyHeader>
      <EmptyMedia illustration="nothing" />
      <EmptyTitle>Nothing asked for yet</EmptyTitle>
      <EmptyDescription>
        When a company asks for an app Composio does not have, it shows here,
        with who asked for it.
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
);

const appsTitle = "Apps asked for";
const appsAbout =
  "Apps the companies asked Grasp to add that Composio does not have, each listed once however many companies asked.";

/** The page: the apps asked for, and the one open. */
const AppsAskedPage = ({
  admins,
  open,
}: {
  admins: readonly ClientAdmin[];
  open: string | undefined;
}) => {
  const apps = askedApps(admins);
  return (
    <AdminPage description={appsAbout} title={appsTitle}>
      {apps.length > 0 ? <AppTable apps={apps} /> : <NothingAsked />}
      <AppSheet apps={apps} open={open} />
    </AdminPage>
  );
};

/** The page, once the apps every company asked for are in: its title at once. */
export const AppsAsked = ({
  admins,
  open,
}: {
  admins: Deferred<ClientAdmin[] | null> | undefined;
  open: string | undefined;
}) => (
  <WithAdmins
    admins={admins}
    fallback={
      <AdminPage description={appsAbout} title={appsTitle}>
        <AdminsLoading />
      </AdminPage>
    }
  >
    {(read) => <AppsAskedPage admins={read} open={open} />}
  </WithAdmins>
);
