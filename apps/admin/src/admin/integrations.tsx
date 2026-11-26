/**
 * The apps the companies asked Grasp to add, as Composio's catalog doesn't
 * have them, for every organization at once (`askedApps`): each app once,
 * with who asked for it and when. A row opens it (`?app=`), listing each
 * company that asked with a link to its integrations.
 */
import { Card, CardContent } from "@grasp-os/ui/components/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink, useNavigate } from "@tanstack/react-router";

import type { ClientAdmin } from "../clients/admin.ts";
import { AdminsLoading, WithAdmins } from "./admins.tsx";
import { askedApps } from "./integrations-asked.ts";
import type { AskedApp } from "./integrations-asked.ts";
import { AdminPage } from "./page.tsx";
import { formatDate, formatList } from "./words.ts";

const styles = stylex.create({
  cell: { display: "flex", flexDirection: "column", gap: space["1"] },
});

/** The companies that asked for an app, by name. */
const askedByOf = (app: AskedApp): string =>
  formatList(app.asks.map((ask) => ask.orgName));

/** One app on one row: its name, who asked for it, and when first. It opens the app. */
const AppRow = ({ app }: { app: AskedApp }) => (
  <TableRow interactive>
    <TableCell rowHeader wrap>
      <Link asChild variant="plain">
        <RouterLink
          aria-label={`Open ${app.name}`}
          data-row-target
          search={{ app: app.key }}
          to="/connectors"
        >
          {app.name}
        </RouterLink>
      </Link>
    </TableCell>
    <TableCell wrap>
      <span {...stylex.props(styles.cell)}>
        <span>{askedByOf(app)}</span>
        <Text as="span" color="muted" size="xs">
          {`First asked on ${formatDate(app.asks[0]?.on ?? "")}`}
        </Text>
      </span>
    </TableCell>
  </TableRow>
);

/** Every app asked for, one row each, the one most asked for first. */
const AppTable = ({ apps }: { apps: readonly AskedApp[] }) => (
  <Card size="sm">
    <CardContent flush>
      <Table aria-label="Apps asked for">
        <TableHeader>
          <TableRow>
            <TableHead>App</TableHead>
            <TableHead>Asked by</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {apps.map((app) => (
            <AppRow app={app} key={app.key} />
          ))}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
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
  <Card size="sm">
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
  </Card>
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
export const AppsAsked = ({ open }: { open: string | undefined }) => (
  <WithAdmins
    fallback={
      <AdminPage description={appsAbout} title={appsTitle}>
        <AdminsLoading />
      </AdminPage>
    }
  >
    {(admins) => <AppsAskedPage admins={admins} open={open} />}
  </WithAdmins>
);
