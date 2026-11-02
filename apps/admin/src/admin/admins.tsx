/**
 * Every organization as its core answered, for a page that shows them
 * all (the overview, Stephen Lab, Ask Grasp, Integrations to build):
 * the frame reads them without waiting (src/routes/__root.tsx), so the
 * page shows at once and this part of it once they are in, a skeleton
 * until then. When they couldn't be read at all, it says so, with Try
 * again, in its place.
 */
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { getRouteApi, rootRouteId, useRouter } from "@tanstack/react-router";
import { Suspense } from "react";
import type { ReactElement } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import { useSettled } from "./settled.tsx";
import type { Deferred } from "./settled.tsx";

const adminRoute = getRouteApi(rootRouteId);

/** What a page shows of the organizations, given them. */
type ShowAdmins = (admins: readonly ClientAdmin[]) => ReactElement;

/** Where the organizations will be, until they are in. */
export const AdminsLoading = () => (
  <div aria-busy className="flex flex-col gap-4" data-loading>
    <span className="sr-only">Reading every organization…</span>
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-40 w-full" />
  </div>
);

/** The organizations couldn't be read: said, with Try again. */
const AdminsUnread = () => {
  const router = useRouter();
  return (
    <Empty role="alert">
      <EmptyHeader>
        <EmptyTitle>The organizations couldn’t be read</EmptyTitle>
        <EmptyDescription>
          Reading them failed just now. The rest of the admin still works.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          onClick={() => {
            void router.invalidate({
              filter: (match) => match.routeId === rootRouteId,
            });
          }}
          size="sm"
          variant="outline"
        >
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
};

const Settled = ({
  admins,
  children,
}: {
  admins: Deferred<ClientAdmin[] | null>;
  children: ShowAdmins;
}) => {
  const read = useSettled(admins);
  return read === null ? <AdminsUnread /> : children(read);
};

/** `children` with every organization, once they are in. */
export const WithAdmins = ({
  children,
  fallback,
}: {
  children: ShowAdmins;
  /** What shows until they are in: a skeleton unless given. */
  fallback?: ReactElement;
}) => {
  const { admins } = adminRoute.useLoaderData();
  return (
    <Suspense fallback={fallback ?? <AdminsLoading />}>
      <Settled admins={admins}>{children}</Settled>
    </Suspense>
  );
};
