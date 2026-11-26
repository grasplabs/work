/**
 * Every organization as its core answered, for a page that shows them
 * all (the overview, Stephen Lab, Ask Grasp, Apps asked for): its loader
 * reads them without waiting (`loadEveryAdmin`, src/admin/org-loads.ts),
 * so the page shows at once and this part of it once they are in, a
 * skeleton until then. When they couldn't be read at all, it says so,
 * with Try again, in its place.
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
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { Suspense } from "react";
import type { ReactElement } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import { useSettled } from "./settled.tsx";
import type { Deferred } from "./settled.tsx";

const styles = stylex.create({
  loading: { display: "flex", flexDirection: "column", gap: space["4"] },
  summary: { height: "6rem" },
  list: { height: "10rem" },
});

/** What a page shows of the organizations, given them. */
type ShowAdmins = (admins: readonly ClientAdmin[]) => ReactElement;

/** Where the organizations will be, until they are in. */
export const AdminsLoading = () => (
  <div aria-busy {...stylex.props(styles.loading)}>
    <span {...stylex.props(visuallyHidden)}>Reading every organization…</span>
    <Skeleton style={styles.summary} variant="rectangular" />
    <Skeleton style={styles.list} variant="rectangular" />
  </div>
);

/** The organizations couldn't be read: said, with Try again. */
const AdminsUnread = () => {
  const router = useRouter();
  return (
    <Empty variant="destructive">
      <EmptyHeader>
        <EmptyTitle>The organizations couldn’t be read</EmptyTitle>
        <EmptyDescription>
          Reading them failed just now. The rest of the admin still works.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          onClick={() => {
            void router.invalidate();
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
  admins,
  children,
  fallback,
}: {
  /** The page's read of them; none while only preloaded, which reads nothing. */
  admins: Deferred<ClientAdmin[] | null> | undefined;
  children: ShowAdmins;
  /** What shows until they are in: a skeleton unless given. */
  fallback?: ReactElement;
}) => {
  const loading = fallback ?? <AdminsLoading />;
  return admins === undefined ? (
    loading
  ) : (
    <Suspense fallback={loading}>
      <Settled admins={admins}>{children}</Settled>
    </Suspense>
  );
};
