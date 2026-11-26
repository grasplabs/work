/**
 * One organization in the admin, as the prototype lays it out
 * (grasplabs/prototype `routes/admin/$orgId.tsx` and
 * `components/admin/org-sidebar.tsx`): a column beside the page with its
 * name, how much Grasp knows about it, and every section, grouped as the
 * company itself, its onboarding, how it uses the platform and the record
 * of it all; a count marks how many things wait for Grasp in a section. On a
 * phone the sections are one choice at the top of the page. Each section
 * has its title, what it is for, and where its figures come from, and
 * under that what the section's own route shows.
 *
 * A client whose core didn't answer opens the same way, its column and
 * every section in it: its Setup shows what the admin itself recorded,
 * and every other section, which needs what its core answers, says why
 * it isn't read now and where to see to it.
 *
 * Not here yet, as the prototype has it: the day stepper at the column's
 * foot (the admin reads a real company, whose day is core's own), and
 * the column folded the way the reader last left it.
 */

import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Text } from "@grasp-os/ui/components/text";
import {
  CircleAlertIcon,
  ClockIcon,
  Icon,
  RefreshCwIcon,
} from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  Outlet,
  useChildMatches,
  useRouter,
} from "@tanstack/react-router";
import { createContext, Fragment, Suspense, use, useState } from "react";
import type { ReactNode } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import type { GridRow } from "../clients/grid.ts";
import { PageBar } from "../frame/page-bar.tsx";
import { channelWords } from "../rollout/channel-words.ts";
import type { OrgRead } from "./org-reads.ts";
import { standingTime } from "./org-status.ts";
import { AdminHeader, barLabels, PageBody } from "./page.tsx";
import {
  orgSections,
  originsOf,
  sectionTo,
  sectionWords,
  sourceNames,
} from "./sections.ts";
import type { OrgSection, Origin } from "./sections.ts";
import { Ago, useSettled } from "./settled.tsx";
import type { Deferred } from "./settled.tsx";
import { standingOfView, standingTones, standingWords } from "./standing.ts";
import type { Standing } from "./standing.ts";
import { organizationOf, unreadWhy, whyUnread } from "./views.ts";
import { plural } from "./words.ts";

const styles = stylex.create({
  // Where the organization stands, over every section: its Badge, then its facts.
  status: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["3"],
    rowGap: space["2"],
  },
  // Under the page's title, its sentence, then where its figures come
  // from and when they were read, a line each.
  lines: { display: "flex", flexDirection: "column", gap: space["1"] },
  buttons: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space["2"],
  },
  loading: { display: "flex", flexDirection: "column", gap: space["4"] },
  skeletonSmall: { height: space["10"] },
  skeletonCard: { height: "7rem" },
  skeletonTable: { height: "12rem" },
  readNote: { display: "flex", alignItems: "center", gap: space["1"] },
  // What the page says under its title, kept as one block of its lines.
  meta: { display: "flex", flexDirection: "column", gap: space["2"] },
});

/** A client whose core answered, with its view. */
export interface AnsweredOrganization {
  admin: Extract<ClientAdmin, { state: "answered" }>;
  view: AdminView;
}

const OrganizationContext = createContext<AnsweredOrganization | null>(null);

/** What the page read of its organization's core, or will: undefined until it is asked. */
const OrgReadContext = createContext<Deferred<OrgRead> | undefined>(undefined);

/** Never settles: what a part waits on while its organization's core isn't asked yet. */
// Never resolved: asked once the page is opened, which loads it anew.
const notAsked: PromiseLike<never> = {
  // oxlint-disable-next-line unicorn/no-thenable -- a thenable is what `use` takes
  then: () => notAsked,
};

/**
 * What the page read of its organization's core, once it is in: the
 * part that asks waits under its own Suspense until then, and the rest
 * of the page, a Setup being typed in included, stays as it is.
 */
export const useOrgRead = (): OrgRead =>
  useSettled(use(OrgReadContext) ?? notAsked);

/** The organization a section is of: only ever rendered under its page. */
export const useOrganization = (): AnsweredOrganization => {
  const organization = use(OrganizationContext);
  if (organization === null) {
    throw new Error("A section is shown only on its organization's page.");
  }
  return organization;
};

/** The organization's section a path is, if it is one. */
const sectionAt = (fullPath: string): OrgSection | undefined => {
  const path = fullPath.endsWith("/") ? fullPath.slice(0, -1) : fullPath;
  return orgSections.find((section) => sectionTo[section] === path);
};

/**
 * The section the page shows, and whether it shows without what its core
 * answers: read off the section route the page renders under it, never
 * off the address, which moves on before the page does. Read off the
 * address, a section about to show could be taken for the Setup while
 * its core isn't read, and shown without its organization.
 */
const useShownSection = (): { section: OrgSection; withoutCore: boolean } => {
  const shown = useChildMatches({
    select: (matches) => {
      const [child] = matches;
      return {
        fullPath: child?.fullPath ?? "",
        withoutCore: child?.staticData.withoutCore === true,
      };
    },
  });
  return {
    section: sectionAt(shown.fullPath) ?? "overview",
    withoutCore: shown.withoutCore,
  };
};

/** A part not read yet, in a sentence: core doesn't hold it, or its system isn't connected. */
const laterLine = ({ source, what = "This" }: Origin): string =>
  source === "core"
    ? `${what}: the company’s own Grasp doesn’t hold it yet.`
    : `${what}: from ${sourceNames[source]}, once it is connected.`;

/**
 * One quiet line under a section's title, only for a part that isn't read
 * yet: where it will come from. What is read says nothing of its source.
 */
const SourceNote = ({ origins }: { origins: readonly Origin[] }) => {
  const lines = origins.filter((origin) => !origin.read).map(laterLine);
  return lines.length === 0 ? null : (
    <Text as="span" color="muted" size="sm">
      {lines.join(" ")}
    </Text>
  );
};

/**
 * Reads the organization's core again, keeping what the page shows until
 * the answer is in: `busy` while it is read.
 */
const useReadAgain = (): { busy: boolean; readAgain: () => void } => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // The router never throws for a load: one that fails shows where it would be.
  const read = async () => {
    setBusy(true);
    await router.invalidate({
      filter: (match) => match.routeId === "/organizations/$clientId",
    });
    setBusy(false);
  };
  return {
    busy,
    readAgain: () => {
      void read();
    },
  };
};

/**
 * Where a section would be, for an organization whose core didn't
 * answer: why, and what to do. Not set up yet, its Setup shows how far
 * that is; not answering, it can be asked again, and its Setup shows why.
 */
const UnreadSection = ({
  admin,
  section,
}: {
  admin: Extract<ClientAdmin, { state: "unreachable" }>;
  section: OrgSection;
}) => {
  const { id: clientId, name } = admin.client;
  const { busy, readAgain } = useReadAgain();
  const unset = admin.error === "not_deployed";
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia icon={unset ? ClockIcon : CircleAlertIcon} variant="icon" />
        <EmptyTitle level={2}>
          {unset ? `${name} isn’t set up yet` : `${name}’s Grasp didn’t answer`}
        </EmptyTitle>
        <EmptyDescription>
          {section === "overview"
            ? `${unreadWhy(admin)} Its Setup shows what the admin itself knows, and what to do.`
            : unreadWhy(admin)}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div {...stylex.props(styles.buttons)}>
          {/* The page's one primary action: a link that looks like a button, announced as the link it is. */}
          <Button asChild>
            <Link params={{ clientId }} to={sectionTo.setup}>
              {unset ? "See how its setting up goes" : "Open its Setup"}
            </Link>
          </Button>
          {unset ? null : (
            <Button disabled={busy} onClick={readAgain} variant="outline">
              <Icon icon={RefreshCwIcon} />
              {busy ? "Asking again…" : "Try again"}
            </Button>
          )}
        </div>
      </EmptyContent>
    </Empty>
  );
};

/** Where a section will be, while its organization's core is read. */
const SectionLoading = () => (
  <div aria-busy {...stylex.props(styles.loading)}>
    <span {...stylex.props(visuallyHidden)}>
      Reading it from the company’s own Grasp…
    </span>
    <Skeleton style={styles.skeletonCard} variant="rectangular" />
    <Skeleton style={styles.skeletonTable} variant="rectangular" />
  </div>
);

/** `text` with its first letter a capital, as a sentence starts. */
const capitalized = (text: string): string =>
  `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/**
 * When what the page shows was read, and a way to read it again: a line
 * under the page's title, in its description.
 */
const ReadLine = ({ at }: { at: string }) => {
  const { busy, readAgain } = useReadAgain();
  return (
    <span {...stylex.props(styles.readNote)}>
      <Text as="span" color="muted" size="xs">
        Read <Ago at={at} />.
      </Text>
      <Button disabled={busy} onClick={readAgain} size="xs" variant="link">
        {busy ? "Reading…" : "Read again"}
      </Button>
    </span>
  );
};

/**
 * Reading it again failed just now: why, above what it last answered,
 * with Try again. Under the page's header, as a note set into the page.
 */
const StaleNote = () => {
  const read = useOrgRead();
  const { busy, readAgain } = useReadAgain();
  if (read.admin.state !== "answered" || read.stale === null) {
    return null;
  }
  return (
    <Alert live="polite" variant="warning">
      <AlertTitle>Its Grasp couldn’t be read again just now</AlertTitle>
      <AlertDescription>
        {`${capitalized(whyUnread(read.stale.error))}. This is what it answered `}
        <Ago at={read.admin.at} />.
      </AlertDescription>
      <AlertAction>
        <Button disabled={busy} onClick={readAgain} size="xs" variant="outline">
          {busy ? "Asking again…" : "Try again"}
        </Button>
      </AlertAction>
    </Alert>
  );
};

/** The section an organization whose core answered is on, under it. */
const AnsweredSection = ({
  organization,
}: {
  organization: AnsweredOrganization;
}) => (
  <OrganizationContext value={organization}>
    <Outlet />
  </OrganizationContext>
);

/** Where the section is: its own content once its core answered, else why it isn't read. */
const SectionGate = ({ section }: { section: OrgSection }) => {
  const { admin } = useOrgRead();
  const { view } = organizationOf(admin);
  if (admin.state === "answered" && view !== null) {
    return <AnsweredSection organization={{ admin, view }} />;
  }
  return admin.state === "answered" ? (
    <SectionLoading />
  ) : (
    <UnreadSection admin={admin} section={section} />
  );
};

/**
 * Where the organization stands, in sight on every section: its standing
 * as a Badge, then how long it has been there, the release it runs on its
 * channel and how many members it has. While its core isn't read: not set
 * up yet, or not answering since when; on its Setup, which says why
 * itself, nothing.
 */
const StatusLine = ({
  client,
  section,
}: {
  client: GridRow;
  section: OrgSection;
}) => {
  const { admin } = useOrgRead();
  const { view } = organizationOf(admin);
  const release =
    client.release === null
      ? null
      : `${client.release} on ${channelWords[client.channel]}`;
  let standing: Standing = "unreachable";
  let facts: ReactNode[] = [];
  if (admin.state === "answered") {
    if (view === null) {
      return null;
    }
    standing = standingOfView(view);
    const members = admin.snapshot.members.length;
    facts = [
      standingTime(standing, view, admin.snapshot),
      release,
      `${members} ${plural(members, "member", "members")}`,
    ];
  } else if (section === "setup") {
    return null;
  } else if (admin.error === "not_deployed") {
    standing = "not_deployed";
    facts = ["Its first release isn’t live yet", release];
  } else {
    facts = [
      admin.lastAnsweredAt === null ? (
        "It has never answered"
      ) : (
        <>
          Last answered <Ago at={admin.lastAnsweredAt} />
        </>
      ),
      release,
    ];
  }
  const shown = facts.filter((fact) => fact !== null);
  return (
    <span {...stylex.props(styles.status)}>
      <Badge variant={standingTones[standing]}>{standingWords[standing]}</Badge>
      <Text as="span" color="muted" size="sm">
        {shown.map((fact, index) => (
          // The facts keep their order: their place names them.
          <Fragment key={index}>
            {index === 0 ? null : " · "}
            {fact}
          </Fragment>
        ))}
      </Text>
    </span>
  );
};

/**
 * Where a section's figures come from, and when they were read, once its
 * core answered: lines of the page's description, as the frontend's pages
 * set what they say of a page under its title.
 */
const ReadNotes = ({ section }: { section: OrgSection }) => {
  const read = useOrgRead();
  const { admin } = read;
  if (admin.state !== "answered") {
    return null;
  }
  return (
    <>
      <SourceNote
        origins={
          originsOf(
            admin.snapshot,
            admin.billing.state === "read",
            admin.crm.state === "read"
          )[section]
        }
      />
      {read.stale === null ? <ReadLine at={admin.at} /> : null}
    </>
  );
};

/**
 * One organization's page: its column of sections and the section it is
 * on, shown at once from what the admin recorded (`client`). What its
 * core answers (`read`; undefined until it is asked) fills in the parts
 * that need it, each in its own place, so the rest of the page stays as
 * it is while it comes: a Setup being typed in keeps what was typed. A
 * section is shown only once its core answered, under it; until then,
 * only one that shows without it (its Setup) is, and in every other's
 * place the page holds its place while it is read, or says why it isn't
 * read and what to do.
 */
export const OrganizationPage = ({
  client,
  read,
}: {
  client: GridRow;
  read: Deferred<OrgRead> | undefined;
}) => {
  const { name } = client;
  const { section, withoutCore } = useShownSection();
  const { title, about } = sectionWords[section];
  return (
    <OrgReadContext value={read}>
      <PageBar
        crumbs={
          section === "overview"
            ? [{ label: name }]
            : [
                {
                  label: name,
                  render: (look) => (
                    <Link
                      {...look}
                      params={{ clientId: client.id }}
                      to="/organizations/$clientId"
                    />
                  ),
                },
                { label: title },
              ]
        }
        labels={barLabels}
      />
      <PageBody>
        <PageHeader
          description={
            <span {...stylex.props(styles.meta)}>
              {section === "overview" ? null : <span>{about}</span>}
              <Suspense fallback={null}>
                <StatusLine client={client} section={section} />
                <span {...stylex.props(styles.lines)}>
                  <ReadNotes section={section} />
                </span>
              </Suspense>
            </span>
          }
          title={section === "overview" ? name : title}
        />
        <Suspense fallback={null}>
          <StaleNote />
        </Suspense>
        {withoutCore ? (
          // Shown at once, and never swapped for anything as the answer comes.
          <Outlet />
        ) : (
          <Suspense fallback={<SectionLoading />}>
            <SectionGate section={section} />
          </Suspense>
        )}
      </PageBody>
    </OrgReadContext>
  );
};

/**
 * An organization the admin offboarded: its core is gone, so nothing of
 * it is read, on any of its sections. Platform keeps what is left of it.
 */
export const OffboardedPage = ({ client }: { client: GridRow }) => (
  <>
    <AdminHeader page={client.name} />
    <PageBody>
      <PageHeader title={client.name} />
      <Empty>
        <EmptyHeader>
          <EmptyTitle level={2}>{`${client.name} was offboarded`}</EmptyTitle>
          <EmptyDescription>
            Its own Grasp is gone, so there is nothing of it to read. Platform
            keeps what is left of it.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {/* A link that looks like a button: it is announced as the link it is. */}
          <Button asChild variant="outline">
            <Link to="/platform/offboarded">Offboarded organizations</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </PageBody>
  </>
);

/** What a section shows until its content is ported: a line saying so. */
export const SectionToCome = () => (
  <Empty>
    <EmptyHeader>
      <EmptyDescription>This section isn’t in the admin yet.</EmptyDescription>
    </EmptyHeader>
  </Empty>
);
