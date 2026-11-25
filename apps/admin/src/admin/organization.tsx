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
import { dateOn, listenDays } from "@grasp-os/shared/admin/onboarding-admin";
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
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import type { SelectItems } from "@grasp-os/ui/components/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Text } from "@grasp-os/ui/components/text";
import {
  CircleAlertIcon,
  ClockIcon,
  Icon,
  RefreshCwIcon,
} from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  Outlet,
  useChildMatches,
  useNavigate,
  useMatchRoute,
  useRouter,
} from "@tanstack/react-router";
import { createContext, Suspense, use, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import type { GridRow } from "../clients/grid.ts";
import type { AnsweredAdmin, OrgRead } from "./org-reads.ts";
import { AdminHeader, PageBody } from "./page.tsx";
import { KnowledgeDots } from "./parts.tsx";
import {
  needSection,
  orgSections,
  originsOf,
  sectionGroups,
  sectionTo,
  sectionWords,
  sourceNames,
} from "./sections.ts";
import type { OrgSection, Origin } from "./sections.ts";
import { Ago, useSettled } from "./settled.tsx";
import type { Deferred } from "./settled.tsx";
import { organizationOf, unreadWhy, whyUnread } from "./views.ts";
import { formatDate, stageLines } from "./words.ts";

const styles = stylex.create({
  // Under the bar, the column beside the section, each as tall as the
  // card: the section scrolls on its own, the column stays.
  row: { flexGrow: 1, minHeight: 0 },
  section: {
    position: "relative",
    flexGrow: 1,
    minWidth: 0,
    overflowY: "auto",
  },
  // The column's head: the organization's name, the fold at the end.
  head: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minHeight: size.sidebarIconButton,
    paddingInlineStart: size.sidebarRowInline,
  },
  headFolded: { justifyContent: "center", paddingInlineStart: 0 },
  name: { flexGrow: 1, minWidth: 0 },
  // How much is known: the dots over a line that says when it opens, in
  // the warning's colour once it waits on Grasp's go.
  knowing: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    minWidth: 0,
  },
  opens: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  opensWaits: { color: colors.warning },
  // The day the interviews are on, at the column's foot.
  day: { display: "flex", flexDirection: "column", gap: space["1"] },
  // Under a desktop's width the sections are the select at the top of the
  // page, as the column has no room beside the admin's sidebar there.
  narrowOnly: { display: { default: null, [media.lg]: "none" } },
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

/** How many dots say how much is known, in the column. */
const knowledgeDots = 20;

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

/**
 * A section's link, with whatever else an anchor takes (a button renders
 * as one): for the overview, only itself is where the page is.
 */
const SectionLink = ({
  section,
  clientId,
  ...props
}: { section: OrgSection; clientId: string } & Omit<
  ComponentProps<"a">,
  "href" | "ref"
>) => (
  <Link
    {...props}
    activeOptions={{ exact: section === "overview", includeSearch: false }}
    params={{ clientId }}
    to={sectionTo[section]}
  />
);

/** What waits for Grasp in a section, in words: "1 thing needs Grasp". */
const waitsWords = (waits: number): string =>
  `${waits} ${waits === 1 ? "thing needs" : "things need"} Grasp`;

/**
 * An entry of the column: its icon and its title, and how many things
 * wait for Grasp there. Folded to its icons, its tooltip says the title
 * and what waits.
 */
const SectionItem = ({
  section,
  clientId,
  waits,
}: {
  section: OrgSection;
  clientId: string;
  waits: number;
}) => {
  const matchRoute = useMatchRoute();
  const { title, icon } = sectionWords[section];
  const active =
    matchRoute({
      to: sectionTo[section],
      params: { clientId },
      fuzzy: section !== "overview",
    }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={waits === 0 ? undefined : `${title}: ${waitsWords(waits)}`}
      >
        <SectionLink clientId={clientId} section={section}>
          <Icon icon={icon} />
          {title}
        </SectionLink>
      </SidebarMenuButton>
      {waits === 0 ? null : (
        <SidebarMenuBadge>
          {waits}
          <span {...stylex.props(visuallyHidden)}>{waitsWords(waits)}</span>
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
};

/** How much is known, and whether it is ready to open: in sight on every section. */
const Knowing = ({ clientId, view }: { clientId: string; view: AdminView }) => {
  const opens = stageLines(view).open;
  const waits = view.knowledge.ready && view.knowledge.opened === null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild size="lg">
        <SectionLink clientId={clientId} section="steps">
          <span {...stylex.props(styles.knowing)}>
            <KnowledgeDots
              count={knowledgeDots}
              knowledge={view.knowledge}
              label={opens}
            />
            <span
              aria-hidden
              {...stylex.props(styles.opens, waits && styles.opensWaits)}
            >
              {opens}
            </span>
          </span>
        </SectionLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

/** The day the interviews are on, which is not today once they are over. */
const InterviewDay = ({ view }: { view: AdminView }) => {
  const date = formatDate(dateOn(view.org, view.day));
  // The last day the links worked: the plan's days count from day 0.
  const lastDay = formatDate(dateOn(view.org, listenDays(view.org) - 1));
  return (
    <div {...stylex.props(styles.day)}>
      <Text as="span" color="muted" size="xs">
        {view.closed
          ? `The interviews closed on ${lastDay}`
          : `The interviews, on ${date}`}
      </Text>
      <Text as="span" color="default" size="xs">
        Day {view.day} of {listenDays(view.org)}
      </Text>
    </div>
  );
};

/** The column's head: the organization's name and the fold; folded, the fold alone. */
const ColumnHead = ({ name }: { name: string }) => {
  const { state } = useSidebar();
  const folded = state === "collapsed";
  return (
    <div {...stylex.props(styles.head, folded && styles.headFolded)}>
      {folded ? null : (
        <h2 {...stylex.props(styles.name)}>
          <Text as="span" color="default" size="sm" truncate weight="medium">
            {name}
          </Text>
        </h2>
      )}
      <SidebarTrigger aria-label="Show or hide the sections" />
    </div>
  );
};

/** What the column says on top while its core isn't read: reading it, or why not. */
const ColumnState = ({
  clientId,
  view,
  reading,
}: {
  clientId: string;
  view: AdminView | null;
  reading: boolean;
}) => {
  const { state } = useSidebar();
  if (state === "collapsed") {
    return null;
  }
  if (view !== null) {
    return <Knowing clientId={clientId} view={view} />;
  }
  return (
    <SidebarMenuItem>
      {reading ? (
        <Skeleton style={styles.skeletonSmall} variant="rectangular" />
      ) : (
        // Nothing of it is known now: where to see why, in sight on every section.
        <Badge asChild variant="warning">
          <SectionLink clientId={clientId} section="setup">
            Not read now: see its Setup
          </SectionLink>
        </Badge>
      )}
    </SidebarMenuItem>
  );
};

/** The day the interviews are on, at the column's foot once the team is told; not on the rail. */
const ColumnFoot = ({ view }: { view: AdminView | null }) => {
  const { state } = useSidebar();
  return view?.told === true && state !== "collapsed" ? (
    <SidebarFooter>
      <InterviewDay view={view} />
    </SidebarFooter>
  ) : null;
};

/**
 * The column beside the organization, as the workspace's pages have one:
 * its name and how much Grasp knows on top, then every section in its
 * groups, and once the team is told, the day its interviews are on.
 * Folded, a rail of the sections' icons.
 */
const ColumnLayout = ({
  name,
  clientId,
  view,
  reading,
}: {
  name: string;
  clientId: string;
  /** Null when its core isn't read now: the column then says so on top. */
  view: AdminView | null;
  /** Its core's answer isn't in yet. */
  reading: boolean;
}) => {
  const waiting = new Map<OrgSection, number>();
  for (const need of view?.needs ?? []) {
    const section = needSection(need);
    waiting.set(section, (waiting.get(section) ?? 0) + 1);
  }
  return (
    <Sidebar aria-label="Sections" collapsible="icon">
      <SidebarHeader>
        <ColumnHead name={name} />
      </SidebarHeader>
      <SidebarContent aria-label={name}>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <ColumnState clientId={clientId} reading={reading} view={view} />
              <SectionItem
                clientId={clientId}
                section="overview"
                waits={waiting.get("overview") ?? 0}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {sectionGroups.map((group) => (
          <SidebarGroup key={group.id}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.sections.map((section) => (
                  <SectionItem
                    clientId={clientId}
                    key={section}
                    section={section}
                    waits={waiting.get(section) ?? 0}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <ColumnFoot view={view} />
    </Sidebar>
  );
};

/** The column once its core's answer is in. */
const SettledColumn = ({
  name,
  clientId,
}: {
  name: string;
  clientId: string;
}) => {
  const { admin } = useOrgRead();
  return (
    <ColumnLayout
      clientId={clientId}
      name={name}
      reading={false}
      view={organizationOf(admin).view}
    />
  );
};

/**
 * The column, and the section beside it, under the page's bar: a Sidebar
 * of its own, with its own fold, which stays as it was left. Every
 * section at once, what waits where once its core answered. Only the
 * column waits on that answer, never the section beside it, so a Setup
 * being typed in keeps what was typed. From a desktop's width on only:
 * below it the sections are the select at the top of the page, as the
 * admin's own sidebar takes the room there.
 */
const OrgColumn = ({
  name,
  clientId,
  children,
}: {
  name: string;
  clientId: string;
  children: ReactNode;
}) => (
  <SidebarProvider keyboardShortcut={false} style={styles.row}>
    <Suspense
      fallback={
        <ColumnLayout clientId={clientId} name={name} reading view={null} />
      }
    >
      <SettledColumn clientId={clientId} name={name} />
    </Suspense>
    {children}
  </SidebarProvider>
);

/** Without room for the column, the sections are one choice at the top of the page. */
const SectionSelect = ({
  clientId,
  section,
}: {
  clientId: string;
  section: OrgSection;
}) => {
  const navigate = useNavigate();
  const items: SelectItems = [
    { value: "overview", label: sectionWords.overview.title },
    ...sectionGroups.map((group) => ({
      type: "group" as const,
      label: group.label,
      items: group.sections.map((each) => ({
        value: each,
        label: sectionWords[each].title,
      })),
    })),
  ];
  return (
    <Select
      items={items}
      onValueChange={(value) => {
        const chosen = orgSections.find((each) => each === value);
        if (chosen !== undefined) {
          void navigate({ to: sectionTo[chosen], params: { clientId } });
        }
      }}
      value={section}
    >
      <SelectTrigger aria-label="Section" style={styles.narrowOnly}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
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
    <Text color="muted" size="sm">
      {lines.join(" ")}
    </Text>
  );
};

/** What the company is, where, and how many people it has, for under its name. */
const aboutOf = (view: AdminView): string => {
  const people = view.org.teams.reduce((sum, team) => sum + team.people, 0);
  return [
    view.org.about,
    view.org.place,
    people > 0 ? `${people} ${people === 1 ? "person" : "people"}` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
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
            ? "Everything here comes from its own Grasp, which the admin can’t read now. Its Setup shows what the admin itself knows, and what to do."
            : unreadWhy(admin)}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div {...stylex.props(styles.buttons)}>
          {unset ? null : (
            <Button disabled={busy} onClick={readAgain}>
              <Icon icon={RefreshCwIcon} />
              {busy ? "Asking again…" : "Try again"}
            </Button>
          )}
          {/* A link that looks like a button: it is announced as the link it is. */}
          <Button asChild variant="outline">
            <Link params={{ clientId }} to={sectionTo.setup}>
              {unset ? "See its Setup progress" : "Its Setup"}
            </Link>
          </Button>
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
 * When what the page shows was read, and a way to read it again; when
 * reading it again failed just now, why, above what it last answered.
 */
const ReadNote = ({ read }: { read: OrgRead & { admin: AnsweredAdmin } }) => {
  const { busy, readAgain } = useReadAgain();
  if (read.stale === null) {
    return (
      <div {...stylex.props(styles.readNote)}>
        <Text as="span" color="muted" size="xs">
          Read <Ago at={read.admin.at} />.
        </Text>
        <Button disabled={busy} onClick={readAgain} size="xs" variant="link">
          {busy ? "Reading…" : "Read again"}
        </Button>
      </div>
    );
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

/** The overview's line under its name: what the company is, or why nothing of it is read. */
const OverviewAbout = () => {
  const { admin } = useOrgRead();
  const { view } = organizationOf(admin);
  if (view !== null) {
    return aboutOf(view);
  }
  return admin.state === "answered" ? "" : unreadWhy(admin);
};

/** Where a section's figures come from, and when they were read, once its core answered. */
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
      <ReadNote read={{ ...read, admin }} />
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
  const { id: clientId, name } = client;
  const { section, withoutCore } = useShownSection();
  const { title, about } = sectionWords[section];
  return (
    <OrgReadContext value={read}>
      <AdminHeader page={name} />
      <OrgColumn clientId={clientId} name={name}>
        <div {...stylex.props(styles.section)}>
          <PageBody>
            <SectionSelect clientId={clientId} section={section} />
            <PageHeader
              description={
                section === "overview" ? (
                  <Suspense fallback={null}>
                    <OverviewAbout />
                  </Suspense>
                ) : (
                  about
                )
              }
              title={section === "overview" ? name : title}
            />
            <Suspense fallback={null}>
              <ReadNotes section={section} />
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
        </div>
      </OrgColumn>
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
