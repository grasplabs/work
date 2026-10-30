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
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
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
  PageSidebar,
  PageSidebarBody,
  PageSidebarTop,
  RailButton,
  RailDivider,
  RailExpand,
} from "@grasp-os/ui/components/page-sidebar";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { cn } from "@grasp-os/ui/lib/utils";
import {
  Link,
  Outlet,
  useChildMatches,
  useNavigate,
  useMatchRoute,
  useRouter,
  rootRouteId,
} from "@tanstack/react-router";
import { HourglassIcon, RotateCcwIcon, UnplugIcon } from "lucide-react";
import { createContext, Fragment, use, useState } from "react";
import type { ComponentProps } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import { AdminHeader, PageBody, PageHeading } from "./page.tsx";
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
import { organizationOf, unreadWhy } from "./views.ts";
import { formatDate, formatList, stageLines } from "./words.ts";

/** A client whose core answered, with its view. */
export interface AnsweredOrganization {
  admin: Extract<ClientAdmin, { state: "answered" }>;
  view: AdminView;
}

const OrganizationContext = createContext<AnsweredOrganization | null>(null);

/**
 * The organization a section is of when its core answered; null on the
 * page of one that didn't, where only its Setup shows.
 */
export const useAnsweredOrganization = (): AnsweredOrganization | null =>
  use(OrganizationContext);

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

/** An entry of the folded column: its icon, named by its tooltip, a link announced as the link it is. */
const RailItem = ({
  section,
  clientId,
  waits,
}: {
  section: OrgSection;
  clientId: string;
  waits: boolean;
}) => {
  const matchRoute = useMatchRoute();
  const { title, icon: Icon } = sectionWords[section];
  const label = waits ? `${title}: something waits for Grasp` : title;
  const active =
    matchRoute({
      to: sectionTo[section],
      params: { clientId },
      fuzzy: section !== "overview",
    }) !== false;
  return (
    <RailButton
      active={active}
      label={label}
      render={<SectionLink clientId={clientId} section={section} />}
    >
      <span className="relative flex">
        <Icon />
        {/* Folded, the column still marks where something waits, as it does open. */}
        {waits ? (
          <span
            aria-hidden
            className="bg-status-attention absolute -top-0.5 -right-0.5 size-1.5 rounded-full"
            data-waits
          />
        ) : null}
      </span>
    </RailButton>
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
 * The column beside the organization, the kit's page sidebar as the
 * workspace's pages have it: its name and how much Grasp knows on top,
 * then every section in its groups, and once the team is told, the day
 * its interviews are on. Folded, a rail of the sections' icons.
 */
const OrgColumn = ({
  name,
  clientId,
  view,
}: {
  name: string;
  clientId: string;
  /** Null when its core isn't read now: the column then says so on top. */
  view: AdminView | null;
}) => {
  const [folded, setFolded] = useState(false);
  const waiting = new Set(view?.needs.map(needSection));

  return (
    <PageSidebar folded={folded} label={name} landmark="navigation">
      {folded ? (
        <>
          <RailExpand
            label="Expand the sections"
            onExpand={() => {
              setFolded(false);
            }}
          />
          <RailDivider />
          <RailItem
            clientId={clientId}
            section="overview"
            waits={waiting.has("overview")}
          />
          {sectionGroups.map((group) => (
            <Fragment key={group.id}>
              <RailDivider />
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
        </>
      ) : (
        <>
          <PageSidebarTop
            fold={{
              label: "Fold the sections",
              onFold: () => {
                setFolded(true);
              },
            }}
            joined
          >
            <h2 className="truncate px-2 font-medium">{name}</h2>
          </PageSidebarTop>
          <PageSidebarBody joined>
            {view === null ? (
              // Nothing of it is known now: where to see why, in sight on every section.
              <SectionLink
                className="text-status-attention hover:bg-muted/60 focus-visible:ring-ring/50 mb-2 flex-none rounded-md px-2 py-1.5 text-xs outline-none focus-visible:ring-3"
                clientId={clientId}
                section="setup"
              >
                Not read now: see its Setup
              </SectionLink>
            ) : (
              <Knowing clientId={clientId} view={view} />
            )}
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
          </PageSidebarBody>
          {view?.told === true ? <InterviewDay view={view} /> : null}
        </>
      )}
    </PageSidebar>
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
  const router = useRouter();
  const { id: clientId, name } = admin.client;
  const unset = admin.error === "not_deployed";
  return (
    <Empty data-unread={admin.error}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {unset ? <HourglassIcon /> : <UnplugIcon />}
        </EmptyMedia>
        <EmptyTitle>
          <h2>
            {unset
              ? `${name} isn’t set up yet`
              : `${name}’s Grasp didn’t answer`}
          </h2>
        </EmptyTitle>
        <EmptyDescription>
          {section === "overview"
            ? "Everything here comes from its own Grasp, which the admin can’t read now. Its Setup shows what the admin itself knows, and what to do."
            : unreadWhy(admin)}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap justify-center gap-2">
          {unset ? null : (
            <Button
              onClick={() => {
                void router.invalidate({
                  filter: (match) => match.routeId === rootRouteId,
                });
              }}
            >
              <RotateCcwIcon data-icon="inline-start" />
              Try again
            </Button>
          )}
          {/* A link that looks like a button: it is announced as the link it is. */}
          <Link
            className={buttonVariants({ variant: "outline" })}
            params={{ clientId }}
            to={sectionTo.setup}
          >
            {unset ? "See its Setup progress" : "Its Setup"}
          </Link>
        </div>
      </EmptyContent>
    </Empty>
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

/**
 * One organization's page: its column of sections and the section it is
 * on. A section is shown only once its core answered, under it; until
 * then, only one that shows without it (its Setup) is, and in every
 * other's place the page says why it isn't read and what to do.
 */
export const OrganizationPage = ({ admin }: { admin: ClientAdmin }) => {
  const { view } = organizationOf(admin);
  const { id: clientId, name } = admin.client;
  const { section, withoutCore } = useShownSection();
  const { title, about } = sectionWords[section];
  const unread = admin.state === "answered" ? null : admin;
  let description = about;
  if (section === "overview") {
    description = unread === null ? "" : unreadWhy(unread);
    description = view === null ? description : aboutOf(view);
  }
  let shown = <Outlet />;
  if (admin.state === "answered" && view !== null) {
    shown = <AnsweredSection organization={{ admin, view }} />;
  } else if (!withoutCore && unread !== null) {
    shown = <UnreadSection admin={unread} section={section} />;
  }
  return (
    <>
      <AdminHeader page={name} />
      <div className="flex min-h-0 flex-1 text-sm">
        <OrgColumn clientId={clientId} name={name} view={view} />
        <div className="relative min-w-0 flex-1 overflow-y-auto">
          <PageBody>
            <SectionSelect clientId={clientId} section={section} />
            <PageHeader>
              <PageHeading
                description={description}
                title={section === "overview" ? name : title}
              >
                {admin.state === "answered" ? (
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
                ) : null}
              </PageHeading>
            </PageHeader>
            {shown}
          </PageBody>
        </div>
      </div>
    </>
  );
};

/** What a section shows until its content is ported: a line saying so. */
export const SectionToCome = () => (
  <Empty>
    <EmptyHeader>
      <EmptyDescription>This section isn’t in the admin yet.</EmptyDescription>
    </EmptyHeader>
  </Empty>
);
