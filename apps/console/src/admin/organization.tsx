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
 * A client whose core didn't answer has no sections: nothing of it is
 * read now, so its page says only why.
 *
 * Not here yet, as the prototype has it: the day stepper at the column's
 * foot (the console reads a real company, whose day is core's own), and
 * the column folded the way the reader last left it.
 */
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { dateOn, listenDays } from "@grasp-os/shared/admin/onboarding-admin";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import {
  Link,
  Outlet,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { createContext, Fragment, use, useState } from "react";
import type { ComponentProps } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import { AdminHeader, AdminPage, PageHeading } from "./page.tsx";
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

/** The section the page is on: the overview unless another's path is. */
const useSection = (clientId: string): OrgSection => {
  const matchRoute = useMatchRoute();
  return (
    orgSections.find(
      (section) =>
        section !== "overview" &&
        matchRoute({
          to: sectionTo[section],
          params: { clientId },
          fuzzy: true,
        }) !== false
    ) ?? "overview"
  );
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

/**
 * The column beside the organization: its name and how much Grasp knows
 * on top, then every section in its groups, and once the team is told,
 * the day its interviews are on. Folded, a rail of the sections' icons.
 */
const OrgColumn = ({
  name,
  clientId,
  view,
}: {
  name: string;
  clientId: string;
  view: AdminView;
}) => {
  const [folded, setFolded] = useState(false);
  const waiting = new Set(view.needs.map(needSection));
  const opens = stageLines(view).open;
  const waits = view.knowledge.ready && view.knowledge.opened === null;
  const date = formatDate(dateOn(view.org, view.day));
  // The last day the links worked: the plan's days count from day 0.
  const lastDay = formatDate(dateOn(view.org, listenDays(view.org) - 1));

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
        {/* How much is known, and whether it is ready to open: in sight on every section. */}
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
      {view.told ? (
        // The day the interviews are on, which is not today once they are over.
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
      ) : null}
    </nav>
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
      {lines.join(" ")}{" "}
      <Link
        className="hover:text-foreground underline underline-offset-4"
        to="/admin/sources"
      >
        Sources
      </Link>
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

/** The page of an organization whose core answered, on `section`. */
const AnsweredPage = ({
  organization,
}: {
  organization: AnsweredOrganization;
}) => {
  const { admin, view } = organization;
  const { id: clientId, name } = admin.client;
  const section = useSection(clientId);
  const { title, about } = sectionWords[section];
  return (
    <>
      <AdminHeader page={name} />
      <div className="flex min-h-0 flex-1 text-sm">
        <OrgColumn clientId={clientId} name={name} view={view} />
        <div className="relative min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-7 pb-6 md:px-9">
            <SectionSelect clientId={clientId} section={section} />
            <PageHeading
              description={section === "overview" ? aboutOf(view) : about}
              title={section === "overview" ? name : title}
            >
              <SourceNote
                origins={
                  originsOf(admin.snapshot, admin.billing.state === "read")[
                    section
                  ]
                }
              />
            </PageHeading>
            <OrganizationContext value={organization}>
              <Outlet />
            </OrganizationContext>
          </div>
        </div>
      </div>
    </>
  );
};

/**
 * One organization's page: its column of sections and the section it is
 * on; or, when its core didn't answer, its name and why nothing of it is
 * read now.
 */
export const OrganizationPage = ({ admin }: { admin: ClientAdmin }) => {
  const { view } = organizationOf(admin);
  if (admin.state !== "answered" || view === null) {
    return (
      <AdminPage
        description={admin.state === "answered" ? undefined : unreadWhy(admin)}
        title={admin.client.name}
      />
    );
  }
  return <AnsweredPage organization={{ admin, view }} />;
};

/** What a section shows until its content is ported: a line saying so. */
export const SectionToCome = () => (
  <p className="text-muted-foreground border-border rounded-xl border border-dashed px-5 py-8 text-center">
    This section isn’t in the console yet.
  </p>
);
