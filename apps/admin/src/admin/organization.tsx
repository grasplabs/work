/**
 * One organization in the admin, as the prototype lays it out
 * (grasplabs/prototype `routes/admin/$orgId.tsx` and
 * `components/admin/org-sidebar.tsx`): a column beside the page with its
 * name, how much Grasp knows about it, and every section, grouped as the
 * company itself, its onboarding, how it uses the platform and the record
 * of it all; a dot marks a section where something waits for Grasp. On a
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
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import {
  Link,
  Outlet,
  useChildMatches,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  createContext,
  Fragment,
  Suspense,
  use,
  useEffect,
  useState,
} from "react";
import type { ComponentProps } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import type { GridRow } from "../clients/grid.ts";
import type { AnsweredAdmin, OrgRead, OrgReads } from "./org-reads.ts";
import { AdminHeader, PageHeading } from "./page.tsx";
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
import { formatDate, formatList, stageLines } from "./words.ts";

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

/** An entry of the open column: its icon, its title, and a dot when something waits for Grasp there. */
const SectionItem = ({
  section,
  clientId,
  waits,
}: {
  section: OrgSection;
  clientId: string;
  waits: boolean;
}) => {
  const { title, icon: Icon } = sectionWords[section];
  return (
    <SectionLink
      className="text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:ring-ring/50 data-[status=active]:bg-muted data-[status=active]:text-foreground flex h-8 flex-none items-center gap-2 rounded-md px-2 transition-colors outline-none focus-visible:ring-3"
      clientId={clientId}
      section={section}
    >
      <Icon aria-hidden className="size-4 flex-none" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {waits ? (
        <>
          <span
            aria-hidden
            className="bg-status-attention size-1.5 flex-none rounded-full"
          />
          <span className="sr-only">Something waits for Grasp</span>
        </>
      ) : null}
    </SectionLink>
  );
};

/** An entry of the folded column: its icon, named by its tooltip. */
const RailItem = ({
  section,
  clientId,
  waits,
}: {
  section: OrgSection;
  clientId: string;
  waits: boolean;
}) => {
  const { title, icon: Icon } = sectionWords[section];
  const label = waits ? `${title}: something waits for Grasp` : title;
  return (
    <Tooltip>
      {/* A link that looks like the rail's buttons: it is announced as the link it is. */}
      <TooltipTrigger
        render={
          <SectionLink
            aria-label={label}
            className={cn(
              buttonVariants({ size: "icon", variant: "ghost" }),
              "data-[status=active]:bg-secondary data-[status=active]:text-secondary-foreground relative"
            )}
            clientId={clientId}
            section={section}
          />
        }
      >
        <Icon />
        {/* Folded, the column still marks where something waits, as it does open. */}
        {waits ? (
          <span
            aria-hidden
            className="bg-status-attention absolute top-1.5 right-1.5 size-1.5 rounded-full"
            data-waits
          />
        ) : null}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
};

/** The column's button that folds it, or opens it again. */
const FoldButton = ({
  folded,
  onFold,
}: {
  folded: boolean;
  onFold: (folded: boolean) => void;
}) => {
  const label = folded ? "Expand the sections" : "Fold the sections";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={() => {
              onFold(!folded);
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        {folded ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
};

/** How much is known, and whether it is ready to open: in sight on every section. */
const Knowing = ({ clientId, view }: { clientId: string; view: AdminView }) => {
  const opens = stageLines(view).open;
  const waits = view.knowledge.ready && view.knowledge.opened === null;
  return (
    <SectionLink
      className="hover:bg-muted/60 focus-visible:ring-ring/50 mb-2 flex flex-none flex-col gap-1.5 rounded-md px-2 py-1.5 outline-none focus-visible:ring-3"
      clientId={clientId}
      section="steps"
    >
      <KnowledgeDots
        count={knowledgeDots}
        knowledge={view.knowledge}
        label={opens}
      />
      <span
        aria-hidden
        className={cn(
          "text-xs",
          waits ? "text-status-attention" : "text-muted-foreground"
        )}
      >
        {opens}
      </span>
    </SectionLink>
  );
};

/** The day the interviews are on, which is not today once they are over. */
const InterviewDay = ({ view }: { view: AdminView }) => {
  const date = formatDate(dateOn(view.org, view.day));
  // The last day the links worked: the plan's days count from day 0.
  const lastDay = formatDate(dateOn(view.org, listenDays(view.org) - 1));
  return (
    <div className="text-muted-foreground flex flex-none flex-col gap-1 border-t px-5 py-3 text-xs">
      <span>
        {view.closed
          ? `The interviews closed on ${lastDay}`
          : `The interviews, on ${date}`}
      </span>
      <span className="text-foreground tabular-nums">
        Day {view.day} of {listenDays(view.org)}
      </span>
    </div>
  );
};

/**
 * The column beside the organization: its name and how much Grasp knows
 * on top, then every section in its groups, and once the team is told,
 * the day its interviews are on. Folded, a rail of the sections' icons.
 */
const ColumnLayout = ({
  name,
  clientId,
  view,
  reading,
  folded,
  setFolded,
}: {
  name: string;
  clientId: string;
  /** Null when its core isn't read now: the column then says so on top. */
  view: AdminView | null;
  /** Its core's answer isn't in yet. */
  reading: boolean;
  folded: boolean;
  setFolded: (folded: boolean) => void;
}) => {
  const waiting = new Set(view?.needs.map(needSection));

  if (folded) {
    return (
      <nav
        aria-label={name}
        className="hidden w-12 flex-none flex-col items-center gap-1 overflow-y-auto border-r py-3 md:flex"
      >
        <FoldButton folded onFold={setFolded} />
        <span aria-hidden className="bg-border my-1.5 h-px w-6" />
        <RailItem
          clientId={clientId}
          section="overview"
          waits={waiting.has("overview")}
        />
        {sectionGroups.map((group) => (
          <Fragment key={group.id}>
            <span aria-hidden className="bg-border my-1.5 h-px w-6" />
            {group.sections.map((section) => (
              <RailItem
                clientId={clientId}
                key={section}
                section={section}
                waits={waiting.has(section)}
              />
            ))}
          </Fragment>
        ))}
      </nav>
    );
  }

  return (
    <nav
      aria-label={name}
      className="hidden w-72 flex-none flex-col border-r md:flex"
    >
      <div className="flex flex-none items-center gap-1.5 px-3 pt-3">
        <h2 className="min-w-0 flex-1 truncate px-2 font-medium">{name}</h2>
        <FoldButton folded={false} onFold={setFolded} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-0.5 pb-3">
        {view === null && reading ? (
          <Skeleton className="mb-2 h-10 flex-none" data-loading />
        ) : null}
        {view === null && !reading ? (
          // Nothing of it is known now: where to see why, in sight on every section.
          <SectionLink
            className="text-status-attention hover:bg-muted/60 focus-visible:ring-ring/50 mb-2 flex-none rounded-md px-2 py-1.5 text-xs outline-none focus-visible:ring-3"
            clientId={clientId}
            section="setup"
          >
            Not read now: see its Setup
          </SectionLink>
        ) : null}
        {view === null ? null : <Knowing clientId={clientId} view={view} />}
        <SectionItem
          clientId={clientId}
          section="overview"
          waits={waiting.has("overview")}
        />
        {sectionGroups.map((group) => (
          <Fragment key={group.id}>
            <span aria-hidden className="bg-border my-2 h-px flex-none" />
            <span className="text-muted-foreground px-2 pb-1 text-xs">
              {group.label}
            </span>
            {group.sections.map((section) => (
              <SectionItem
                clientId={clientId}
                key={section}
                section={section}
                waits={waiting.has(section)}
              />
            ))}
          </Fragment>
        ))}
      </div>
      {view?.told === true ? <InterviewDay view={view} /> : null}
    </nav>
  );
};

/** The column once its core's answer is in. */
const SettledColumn = (props: {
  name: string;
  clientId: string;
  folded: boolean;
  setFolded: (folded: boolean) => void;
}) => {
  const { admin } = useOrgRead();
  return (
    <ColumnLayout
      {...props}
      reading={false}
      view={organizationOf(admin).view}
    />
  );
};

/** The column: every section at once, what waits where once its core answered. */
const OrgColumn = ({ name, clientId }: { name: string; clientId: string }) => {
  // Kept here, above what fills in, so the column stays as it was left.
  const [folded, setFolded] = useState(false);
  const column = { name, clientId, folded, setFolded };
  return (
    <Suspense fallback={<ColumnLayout {...column} reading view={null} />}>
      <SettledColumn {...column} />
    </Suspense>
  );
};

/** Without room for the column, the sections are one choice at the top of the page. */
const SectionSelect = ({
  clientId,
  section,
}: {
  clientId: string;
  section: OrgSection;
}) => {
  const navigate = useNavigate();
  const items = orgSections.map((each) => ({
    value: each,
    label: sectionWords[each].title,
  }));
  return (
    <div className="md:hidden">
      <Select
        items={items}
        onValueChange={(value: OrgSection | null) => {
          if (value !== null) {
            void navigate({ to: sectionTo[value], params: { clientId } });
          }
        }}
        value={section}
      >
        <SelectTrigger aria-label="Section" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="overview">
              {sectionWords.overview.title}
            </SelectItem>
          </SelectGroup>
          {sectionGroups.map((group) => (
            <SelectGroup key={group.id}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.sections.map((each) => (
                <SelectItem key={each} value={each}>
                  {sectionWords[each].title}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

/** A part not read yet, in a sentence: core doesn't hold it, or its system isn't connected. */
const laterLine = ({ source, what = "This" }: Origin): string =>
  source === "core"
    ? `${what}: the company’s own Grasp doesn’t hold it yet.`
    : `${what}: from ${sourceNames[source]}, once it is connected.`;

/**
 * One quiet line under a section's title: where what it shows comes from,
 * and for a part that isn't read yet, where it will.
 */
const SourceNote = ({ origins }: { origins: readonly Origin[] }) => {
  const read = [
    ...new Set(
      origins
        .filter((origin) => origin.read)
        .map(({ source }) => sourceNames[source])
    ),
  ];
  const lines = [
    ...(read.length > 0 ? [`From ${formatList(read)}.`] : []),
    ...origins.filter((origin) => !origin.read).map(laterLine),
  ];
  return (
    <p className="text-muted-foreground text-xs" data-slot="source-note">
      {lines.join(" ")}
    </p>
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
  const { busy, readAgain } = useReadAgain();
  const { id: clientId, name } = admin.client;
  const unset = admin.error === "not_deployed";
  return (
    <Empty data-unread={admin.error}>
      <EmptyHeader>
        <EmptyTitle>
          {unset ? `${name} isn’t set up yet` : `${name}’s Grasp didn’t answer`}
        </EmptyTitle>
        <EmptyDescription>
          {section === "overview"
            ? "Everything here comes from its own Grasp, which the admin can’t read now. Its Setup shows what the admin itself knows, and what to do."
            : unreadWhy(admin)}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        {unset ? null : (
          <Button disabled={busy} onClick={readAgain} size="sm">
            {busy ? "Asking again…" : "Try again"}
          </Button>
        )}
        {/* A link that looks like a button: it is announced as the link it is. */}
        <Link
          className={buttonVariants({ size: "sm", variant: "outline" })}
          params={{ clientId }}
          to={sectionTo.setup}
        >
          {unset ? "See its Setup progress" : "Its Setup"}
        </Link>
      </EmptyContent>
    </Empty>
  );
};

/** Where a section will be, while its organization's core is read. */
const SectionLoading = () => (
  <div aria-busy className="flex flex-col gap-4" data-loading>
    <span className="sr-only">Reading it from the company’s own Grasp…</span>
    <Skeleton className="h-28 w-full" />
    <Skeleton className="h-48 w-full" />
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
  const again = (
    <Button disabled={busy} onClick={readAgain} size="xs" variant="link">
      {busy ? "Reading…" : "Read again"}
    </Button>
  );
  if (read.stale === null) {
    return (
      <p
        className="text-muted-foreground flex items-center gap-1 text-xs"
        data-slot="read-note"
      >
        <span>
          Read <Ago at={read.admin.at} />.
        </span>
        {again}
      </p>
    );
  }
  return (
    <Alert data-slot="read-note" live="polite" variant="attention">
      <TriangleAlertIcon />
      <AlertTitle>Its Grasp couldn’t be read again just now</AlertTitle>
      <AlertDescription>
        {`${capitalized(whyUnread(read.stale.error))}. This is what it answered `}
        <Ago at={read.admin.at} />.
      </AlertDescription>
      <AlertAction>
        <Button disabled={busy} onClick={readAgain} size="sm" variant="outline">
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
  let about = "";
  if (view !== null) {
    about = aboutOf(view);
  } else if (admin.state !== "answered") {
    about = unreadWhy(admin);
  }
  return about === "" ? null : (
    <p className="text-muted-foreground text-sm">{about}</p>
  );
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
            admin.proposal.state === "read",
            admin.crm.state === "read"
          )[section]
        }
      />
      <ReadNote read={{ ...read, admin }} />
    </>
  );
};

/**
 * Keeps the answer the page shows in its router's reads: one read on the
 * server, for the page this tab opened on, too; read again and not
 * answering, the page keeps it.
 */
const KeepRead = ({ reads }: { reads: OrgReads }) => {
  const { admin } = useOrgRead();
  useEffect(() => {
    reads.remember(admin);
  }, [reads, admin]);
  return null;
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
  reads,
}: {
  client: GridRow;
  read: Deferred<OrgRead> | undefined;
  reads: OrgReads;
}) => {
  const { id: clientId, name } = client;
  const { section, withoutCore } = useShownSection();
  const { title, about } = sectionWords[section];
  return (
    <OrgReadContext value={read}>
      <AdminHeader page={name} />
      <Suspense fallback={null}>
        <KeepRead reads={reads} />
      </Suspense>
      <div className="flex min-h-0 flex-1 text-sm">
        <OrgColumn clientId={clientId} name={name} />
        <div className="relative min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-7 pb-6 md:px-9">
            <SectionSelect clientId={clientId} section={section} />
            <PageHeading
              description={section === "overview" ? undefined : about}
              title={section === "overview" ? name : title}
            >
              {section === "overview" ? (
                <Suspense fallback={null}>
                  <OverviewAbout />
                </Suspense>
              ) : null}
              <Suspense fallback={null}>
                <ReadNotes section={section} />
              </Suspense>
            </PageHeading>
            {withoutCore ? (
              // Shown at once, and never swapped for anything as the answer comes.
              <Outlet />
            ) : (
              <Suspense fallback={<SectionLoading />}>
                <SectionGate section={section} />
              </Suspense>
            )}
          </div>
        </div>
      </div>
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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-7 pb-6 text-sm md:px-9">
      <PageHeading title={client.name} />
      <Empty data-unread="offboarded">
        <EmptyHeader>
          <EmptyTitle>{`${client.name} was offboarded`}</EmptyTitle>
          <EmptyDescription>
            Its own Grasp is gone, so there is nothing of it to read. Platform
            keeps what is left of it.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {/* A link that looks like a button: it is announced as the link it is. */}
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            to="/platform/offboarded"
          >
            Offboarded organizations
          </Link>
        </EmptyContent>
      </Empty>
    </div>
  </>
);

/** What a section shows until its content is ported: a line saying so. */
export const SectionToCome = () => (
  <p className="text-muted-foreground border-border rounded-xl border border-dashed px-5 py-8 text-center">
    This section isn’t in the admin yet.
  </p>
);
