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
  Sheet,
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
import {
  getRouteApi,
  Link,
  rootRouteId,
  useNavigate,
} from "@tanstack/react-router";
import { BlocksIcon } from "lucide-react";

import { askedApps } from "./integrations-asked.ts";
import type { AskedApp } from "./integrations-asked.ts";
import { AdminPage } from "./page.tsx";
import { formatDate, formatList } from "./words.ts";

/** Every organization, as the admin's layout read them. */
const adminRoute = getRouteApi(rootRouteId);

/** The companies that asked for an app, by name. */
const askedByOf = (app: AskedApp): string =>
  formatList(app.asks.map((ask) => ask.orgName));

/** One app on one row: its name, who asked for it, and when first. It opens the app. */
const AppRow = ({ app }: { app: AskedApp }) => (
  <TableRow className="relative">
    <TableCell className="whitespace-normal" variant="card">
      <Link
        aria-label={`Open ${app.name}`}
        className="focus-visible:ring-ring/50 flex w-full min-w-0 flex-col rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-3"
        search={{ app: app.key }}
        to="/integrations"
      >
        <span className="font-medium hover:underline">{app.name}</span>
        {/* Where there is no room for its own column, who asked goes under the name. */}
        <span className="text-muted-foreground text-xs @xl:hidden">
          {askedByOf(app)}
        </span>
      </Link>
    </TableCell>
    <TableCell
      className="hidden whitespace-normal @xl:table-cell"
      variant="card"
    >
      <span className="flex flex-col">
        <span>{askedByOf(app)}</span>
        <span className="text-muted-foreground text-xs">
          {`First asked on ${formatDate(app.asks[0]?.on ?? "")}`}
        </span>
      </span>
    </TableCell>
  </TableRow>
);

/** Every app asked for, one row each, the one most asked for first. */
const AppTable = ({ apps }: { apps: readonly AskedApp[] }) => (
  <section className="bg-card @container overflow-hidden rounded-xl border">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead variant="card">App</TableHead>
          <TableHead className="hidden @xl:table-cell" variant="card">
            Asked by
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apps.map((app) => (
          <AppRow app={app} key={app.key} />
        ))}
      </TableBody>
    </Table>
  </section>
);

/** The app open in its sheet, when `open` names one asked for: each company that asked. */
const AppSheet = ({
  apps,
  open,
}: {
  apps: readonly AskedApp[];
  open: string | undefined;
}) => {
  const navigate = useNavigate({ from: "/integrations" });
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
      <SheetContent className="overflow-y-auto" size="wide">
        {shown === undefined ? null : (
          <>
            <SheetHeader>
              <SheetTitle>{shown.name}</SheetTitle>
              <SheetDescription>Who asked for it, and when.</SheetDescription>
            </SheetHeader>
            <ul className="flex flex-col gap-3 p-4 text-sm">
              {shown.asks.map((ask) => (
                <li className="flex flex-col gap-0.5" key={ask.org}>
                  <Link
                    className="w-fit font-medium underline-offset-4 hover:underline"
                    params={{ clientId: ask.org }}
                    to="/organizations/$clientId/integrations"
                  >
                    {ask.orgName}
                  </Link>
                  <span className="text-muted-foreground text-xs">
                    {`Asked on ${formatDate(ask.on)}`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
};

/** Where the table goes, while nothing is asked for. */
const NothingAsked = () => (
  <section className="bg-card rounded-xl border">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BlocksIcon />
        </EmptyMedia>
        <EmptyTitle>Nothing asked for yet</EmptyTitle>
        <EmptyDescription>
          When a company asks for an app Composio does not have, it shows here,
          with who asked for it.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  </section>
);

/** The page: the apps asked for, and the one open. */
export const AppsAsked = ({ open }: { open: string | undefined }) => {
  const apps = askedApps(adminRoute.useLoaderData().admins);
  return (
    <AdminPage
      description="Apps the companies asked Grasp to add that Composio does not have, each listed once however many companies asked."
      title="Apps asked for"
    >
      <div className="flex flex-col gap-6 text-sm">
        {apps.length > 0 ? <AppTable apps={apps} /> : <NothingAsked />}
      </div>
      <AppSheet apps={apps} open={open} />
    </AdminPage>
  );
};
