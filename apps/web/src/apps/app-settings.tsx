import { appLimits } from "@grasp-os/shared/app-limits";
import type {
  App,
  AppAnswerer,
  AppChanges,
  AppMember,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type { OfferedCatalog } from "@grasp-os/shared/connect";
import type { SurfaceSummary } from "@grasp-os/shared/pages";
import { canBuild, isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Textarea } from "@grasp-os/ui/components/textarea";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import { ArchiveIcon, LinkIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { HttpConnectionItem } from "../connections/http-connections.tsx";
import { IntegrationRow } from "../connections/integration-row.tsx";
import {
  httpConnectionsOf,
  integrationsOf,
} from "../connections/integrations.ts";
import type { HttpListed, Integration } from "../connections/integrations.ts";
import { timeoutMs, withTimeout } from "../core.ts";
import type { Session } from "../core.ts";
import { decidesRequests } from "../dashboard/waiting.ts";
import { readPeople } from "../directory.ts";
import { DraftHistory } from "../drafts/draft-history.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { PageFrame } from "../pages/page-frame.tsx";
import {
  SettingsBody,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AppAccessRequests } from "./app-access-requests.tsx";
import { ExportDefinition } from "./app-definition.tsx";
import { AppIntegrations } from "./app-integrations.tsx";
import { AppLinkDialog, linkAddress } from "./app-own-link.tsx";
import { AppOwner } from "./app-owner.tsx";
import { RemoveApp } from "./app-remove.tsx";
import { ResetAppData } from "./app-reset.tsx";
import { buildsApp } from "./app-role.ts";
import { AppMembers, readMembers } from "./app-sharing.tsx";
import {
  ArchiveDialog,
  StatusBadge,
  StatusNote,
  useStatusMove,
} from "./app-status.tsx";
import { AppWebhooks, WebhookList } from "./app-webhooks.tsx";
import { AppWorkflows } from "./app-workflows.tsx";
import { SaveAsBlueprint } from "./blueprints.tsx";
import { ResourceBindings } from "./resource-bindings.tsx";
import type { ResourcesPage } from "./resource-bindings.tsx";
import { useAppRead } from "./use-app-read.ts";
import type { AppRead } from "./use-app-read.ts";

// Everything about an App besides the App itself, in one place, grouped
// plainly, a section at a time: what it is called and where it stands
// (General), whom it is shared with (Sharing), its History (unpublished
// changes and published versions), its connections (with the workflows it
// binds), webhooks, and the settings page the App
// declares itself (Options). Its builders reach it beside the chat in
// the App's workspace (app-workspace.tsx); anyone else who opens the
// App, from the live App's bar (_shell.apps.$app_.settings.tsx). Each
// section reads what it shows as it opens (use-app-read.ts), so one
// that is slow or refused leaves the others; core checks every change.

/** The sections, in the order the list shows them. */
const appSettingsSections = [
  "general",
  "sharing",
  "history",
  "connections",
  "webhooks",
  "options",
] as const;

export type AppSettingsSection = (typeof appSettingsSections)[number];

/** A section named in an address, or none for anything else. */
export const settingsSectionOf = (
  value: unknown
): AppSettingsSection | undefined =>
  appSettingsSections.find((section) => section === value);

const sectionLabels: Record<AppSettingsSection, MessageDescriptor> = {
  general: msg({ message: "General", context: "an app's settings section" }),
  sharing: msg({ message: "Sharing", context: "an app's settings section" }),
  history: msg({ message: "History", context: "an app's settings section" }),
  connections: msg({
    message: "Connections",
    context: "an app's settings section",
  }),
  webhooks: msg({ message: "Webhooks", context: "an app's settings section" }),
  options: msg({
    message: "Options",
    context: "the settings an app offers itself",
  }),
};

/**
 * That a section shows what was read before, a latest re-read of one of
 * its `reads` having failed: why, and a way to read every failed one
 * again. Nothing while none failed.
 */
const RefreshFailed = ({
  reads,
}: {
  reads: readonly (AppRead<unknown> | undefined)[];
}) => {
  const failed = reads.flatMap((read) => read?.refresh ?? []);
  const [first] = failed;
  if (first === undefined) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3.5 py-3 text-sm">
      <TriangleAlertIcon
        aria-hidden="true"
        className="text-status-attention size-4 flex-none"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">
          <Trans>Couldn&apos;t refresh. This may be out of date.</Trans>
        </p>
        <NotLoaded page={first.failure} />
      </div>
      <Button
        onClick={() => {
          for (const { retry } of failed) {
            retry();
          }
        }}
        size="sm"
        variant="outline"
      >
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
};

/**
 * What a section shows of a read: a skeleton while it comes, why it
 * didn't, or `children` once it did, over a note while a re-read failed
 * unless the section notes that once for all its reads (`notedAbove`).
 */
export const Read = <T,>({
  read,
  notedAbove = false,
  children,
}: {
  read: AppRead<T> | undefined;
  notedAbove?: boolean;
  children: (data: T) => ReactElement;
}) => {
  if (read === undefined) {
    return <LoadingLines />;
  }
  if (read.state !== "ready") {
    return <NotLoaded page={read} />;
  }
  return (
    <>
      {notedAbove ? null : <RefreshFailed reads={[read]} />}
      {children(read.data)}
    </>
  );
};

/** A section's heading and what it is for. */
const SectionHeading = ({
  title,
  description,
}: {
  title: string;
  description?: ReactNode;
}) => (
  <div className="flex flex-col gap-1">
    <h2 className="text-lg font-medium">{title}</h2>
    {description === undefined ? null : (
      <p className="text-muted-foreground">{description}</p>
    )}
  </div>
);

// --- General -------------------------------------------------------------

/** Nobody in particular, as the "Made for" picker's value. */
const nobody = "nobody";

/** A member reference as one picker value: `person:<id>` or `team:<id>`. */
const refValue = ({ type, id }: { type: string; id: string }): string =>
  `${type}:${id}`;

/** A text setting, saved when the field is left, or on Enter for one line. */
const SavedText = ({
  id,
  value,
  disabled,
  readOnly,
  multiline = false,
  maxLength,
  onSave,
}: {
  id: string;
  value: string;
  disabled: boolean;
  /** Shown to read, not to change: for someone who doesn't build it. */
  readOnly: boolean;
  multiline?: boolean;
  maxLength: number;
  onSave: (next: string) => void;
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const save = (): void => {
    const next = draft?.trim();
    setDraft(null);
    // A name can't be emptied; a purpose can.
    if (next !== undefined && next !== value && (multiline || next !== "")) {
      onSave(next);
    }
  };
  const shared = {
    disabled,
    id,
    maxLength,
    onBlur: save,
    readOnly,
    value: draft ?? value,
  };
  return multiline ? (
    <Textarea
      {...shared}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      rows={2}
    />
  ) : (
    <Input
      {...shared}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(null);
        }
      }}
    />
  );
};

/** Archive (asking first) or Restore, for its builders. */
const PuttingAway = ({ app }: { app: App }) => {
  const { busy, failure, move } = useStatusMove(app.id);
  const [archiving, setArchiving] = useState(false);
  const { archived } = app;
  return (
    <div className="flex flex-col items-start gap-2 border-t px-5 py-4 sm:items-end">
      {archived ? (
        <Button
          disabled={busy}
          onClick={() => {
            move("restore");
          }}
          variant="outline"
        >
          <Trans>Restore</Trans>
        </Button>
      ) : (
        <Button
          disabled={busy}
          onClick={() => {
            setArchiving(true);
          }}
          variant="outline"
        >
          <ArchiveIcon data-icon="inline-start" />
          {app.currentVersion === null ? (
            <Trans>Archive</Trans>
          ) : (
            <Trans>Archive and take offline</Trans>
          )}
        </Button>
      )}
      <ErrorText>{failure}</ErrorText>
      <ArchiveDialog
        name={app.name}
        onArchive={() => {
          setArchiving(false);
          move("archive");
        }}
        onOpenChange={setArchiving}
        open={archiving}
      />
    </div>
  );
};

/** What General reads: whom it is shared with, names, and who may answer for it. */
interface GeneralRead {
  members: AppMember[];
  people: ReadonlyMap<string, string>;
  /**
   * Who may answer for it, as core decides (`apps.answerers`); null when
   * that couldn't be read in time, never an empty list mistaken for
   * nobody else.
   */
  answerers: AppAnswerer[] | null;
}

const answerersOrFailed = async (
  session: Session,
  app: string
): Promise<AppAnswerer[] | null> => {
  try {
    return await withTimeout(session.apps.answerers(app), timeoutMs);
  } catch {
    return null;
  }
};

/** General's read; everyone's names only for an admin, who may list members. */
const readGeneral =
  (admin: boolean) =>
  async (session: Session, app: string): Promise<GeneralRead> => {
    const [members, people, answerers] = await Promise.all([
      session.apps.members.list(app),
      admin ? readPeople(session) : Promise.resolve(new Map<string, string>()),
      answerersOrFailed(session, app),
    ]);
    return { members, people, answerers };
  };

const readGeneralAsAdmin = readGeneral(true);
const readGeneralAsMember = readGeneral(false);

/** The App's own address, and setting it, for its builders. */
const OwnLink = ({ app }: { app: App }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        {app.link === null ? <Trans>None yet</Trans> : linkAddress(app.link)}
      </span>
      <Button
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <LinkIcon data-icon="inline-start" />
        <Trans>Set the link</Trans>
      </Button>
      <AppLinkDialog app={app} onOpenChange={setOpen} open={open} />
    </div>
  );
};

/** What only its builders do with the App: copy it, put it away, delete it. */
const ForBuilders = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const { currentVersion } = app;
  return (
    <>
      <SettingsSection
        description={t`Its definition to keep or move, and a blueprint others can start from.`}
        title={t`Copies`}
      >
        <SettingsBody>
          <div className="flex flex-wrap items-start gap-2">
            <ExportDefinition app={app} identity={identity} />
            {canBuild(identity.role) && currentVersion !== null ? (
              <SaveAsBlueprint
                app={app.id}
                name={app.name}
                version={currentVersion}
              />
            ) : null}
            {currentVersion === null ? (
              <p className="text-muted-foreground">
                <Trans>Once it has a version, it can be copied.</Trans>
              </p>
            ) : null}
          </div>
        </SettingsBody>
      </SettingsSection>
      {app.archived || identity.staff || !isAdmin(identity.role) ? null : (
        <SettingsSection
          description={t`Only an admin resets an App’s data: every record goes for good, and its current version runs again with no records.`}
          title={t`Its data`}
        >
          <SettingsBody>
            <ResetAppData app={app} />
          </SettingsBody>
        </SettingsSection>
      )}
      <SettingsSection
        description={t`An archived App is kept as it was and goes offline: nobody opens it, its triggers stop and its unfinished runs are cancelled. A builder can restore it, as a draft.`}
        title={t`Putting it away`}
      >
        <PuttingAway app={app} />
        <div className="flex justify-end px-5 pb-4 empty:hidden">
          <RemoveApp app={app} identity={identity} />
        </div>
      </SettingsSection>
    </>
  );
};

const GeneralForm = ({
  app,
  read,
  identity,
  builds,
}: {
  app: ViewedApp;
  read: GeneralRead;
  identity: Identity;
  builds: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { members, people, answerers: eligible } = read;
  const change = (changes: AppChanges): void => {
    void run(async (session) => {
      await changeThenRefresh(
        async () => await session.apps.update(app.id, changes),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  // Names from whom it is shared with, who may answer for it, and, for an
  // admin, everyone's.
  const names = new Map(people);
  for (const member of members) {
    if (member.type === "person" && member.name !== null) {
      names.set(member.id, member.name);
    }
  }
  for (const { id, name } of eligible ?? []) {
    names.set(id, name);
  }
  const personName = (userId: string): string => names.get(userId) ?? userId;
  const nameOf = (member: AppMember): string =>
    member.name ??
    (member.type === "person" ? personName(member.id) : member.id);
  // Whom it may be made for: a person or team it is shared with, never a
  // project's row.
  const current = app.audience === null ? nobody : refValue(app.audience);
  const audienceMembers = members.flatMap((member) =>
    member.type === "project" ? [] : [{ ...member, type: member.type }]
  );
  const audiences = [
    { value: nobody, label: t`Nobody in particular` },
    ...audienceMembers.map((member) => ({
      value: refValue(member),
      label: nameOf(member),
    })),
  ];
  // One it is made for that it is no longer shared with, as named.
  if (
    !audiences.some(({ value }) => value === current) &&
    app.audience !== null
  ) {
    audiences.push({
      value: current,
      label:
        app.audience.type === "team"
          ? t`A team it is no longer shared with`
          : t`Someone it is no longer shared with`,
    });
  }
  const disabled = !builds || busy;
  const person = names.get(app.owner);
  const date = formatDateTime(app.createdAt);
  return (
    <>
      <p className="text-muted-foreground">
        {person === undefined ? (
          <Trans>Made on {date}.</Trans>
        ) : (
          <Trans>
            Made by {person} on {date}.
          </Trans>
        )}
      </p>
      <SettingsSection
        description={t`What the App is called and what it is for.`}
        title={t`About`}
      >
        <SettingsRow htmlFor="app-name" label={t`Name`}>
          <SavedText
            disabled={busy}
            id="app-name"
            maxLength={appLimits.nameLength}
            readOnly={!builds}
            onSave={(name) => {
              change({ name });
            }}
            value={app.name}
          />
        </SettingsRow>
        <SettingsRow
          htmlFor="app-purpose"
          label={t({
            message: "What it is for",
            context: "what an app is for, in a sentence",
          })}
        >
          <SavedText
            disabled={busy}
            id="app-purpose"
            maxLength={appLimits.descriptionLength}
            readOnly={!builds}
            multiline
            onSave={(description) => {
              change({ description });
            }}
            value={app.description}
          />
        </SettingsRow>
        <SettingsRow label={t`Status`}>
          <div className="flex flex-col items-start gap-1">
            <StatusBadge app={app} />
            <StatusNote app={app} />
          </div>
        </SettingsRow>
        <SettingsRow
          description={t`Shown with the App. It opens the App to nobody: who may use it is who it is shared with.`}
          htmlFor="app-audience"
          label={t`Made for`}
        >
          <Select
            disabled={disabled}
            items={audiences}
            onValueChange={(value: unknown) => {
              if (typeof value !== "string") {
                return;
              }
              const member = audienceMembers.find(
                (each) => refValue(each) === value
              );
              change({
                audience:
                  member === undefined
                    ? null
                    : { type: member.type, id: member.id },
              });
            }}
            value={current}
          >
            <SelectTrigger className="w-full" id="app-audience">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {audiences.map((audience) => (
                <SelectItem key={audience.value} value={audience.value}>
                  {audience.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        {builds && !app.archived ? (
          <SettingsRow
            description={t`Its own address, for whoever may use it while it is live.`}
            label={t`Link`}
          >
            <OwnLink app={app} />
          </SettingsRow>
        ) : null}
        {failure === undefined ? null : (
          <div className="border-t px-5 py-3">
            <ErrorText>{failure}</ErrorText>
          </div>
        )}
      </SettingsSection>
      <SettingsSection
        description={t`Who answers for the App: who is asked about it and decides what changes.`}
        title={t({ message: "Owner", context: "who answers for an app" })}
      >
        {/* The platform's one owner control, as a workflow's line has it. */}
        <SettingsBody>
          <AppOwner
            // Not read for someone who doesn't build it, who only looks.
            answerers={builds ? eligible : (eligible ?? [])}
            disabled={disabled}
            onPick={(responsible) => {
              change({ responsible });
            }}
            onRetry={() => {
              void router.invalidate();
            }}
            owner={{
              id: app.responsible,
              name: personName(app.responsible),
            }}
          />
        </SettingsBody>
      </SettingsSection>
      {builds ? (
        <ForBuilders app={app} identity={identity} />
      ) : (
        <p className="text-muted-foreground">
          <Trans>Only its builders change these settings.</Trans>
        </p>
      )}
    </>
  );
};

const General = ({
  app,
  identity,
  builds,
}: {
  app: ViewedApp;
  identity: Identity;
  builds: boolean;
}) => {
  const read = useAppRead(
    app.id,
    isAdmin(identity.role) ? readGeneralAsAdmin : readGeneralAsMember
  );
  return (
    <Read read={read}>
      {(loaded) => (
        <GeneralForm
          app={app}
          builds={builds}
          identity={identity}
          read={loaded}
        />
      )}
    </Read>
  );
};

// --- Sharing -------------------------------------------------------------

const Sharing = ({ app, identity }: { app: ViewedApp; identity: Identity }) => {
  const read = useAppRead(app.id, readMembers);
  return (
    <Read read={read}>
      {(members) => (
        <AppMembers app={app} identity={identity} members={members} />
      )}
    </Read>
  );
};

// --- Connections ---------------------------------------------------------

/** The catalog's entries, or null when it can't be read in time. */
const catalogOrNone = async (
  session: Session
): Promise<OfferedCatalog["entries"] | null> => {
  try {
    const { entries } = await withTimeout(
      session.connections.catalog(),
      timeoutMs / 2
    );
    return entries;
  } catch {
    return null;
  }
};

/**
 * The integrations the App uses: those of the connections it asked to use
 * or may use now (its permissions), each with only those connections, so
 * its state is the App's, not the viewer's; and the HTTP connections it
 * uses, which no integration lists (`http`). A connection the App holds
 * that the viewer can't see (someone else's personal one, or one since
 * disconnected) isn't listed: core has no read of it for them.
 */
const readUsed = async (
  session: Session,
  app: string
): Promise<{ integrations: Integration[]; http: HttpListed[] }> => {
  const [permissions, connections, catalog] = await Promise.all([
    session.permissions.list({ type: "app", appId: app }),
    session.connections.list(),
    // Only for names: a catalog slow to answer, or refused, leaves the
    // integrations by their IDs, and the HTTP connections, which no entry
    // lists, as they are.
    catalogOrNone(session),
  ]);
  const used = new Set<string>(
    permissions.flatMap(({ object, status }) =>
      object.type === "connection" && status !== "revoked"
        ? [object.connectionId]
        : []
    )
  );
  const integrations = integrationsOf(catalog ?? [], connections)
    .map((integration) => ({
      ...integration,
      connections: integration.connections.filter(({ id }) => used.has(id)),
    }))
    .filter(({ connections: held }) => held.length > 0);
  const http = httpConnectionsOf(connections).filter(({ connection }) =>
    used.has(connection.id)
  );
  return { integrations, http };
};

const readDeclared = async (session: Session, app: string) => {
  const [integrations, catalog] = await Promise.all([
    session.apps.integrations.list(app),
    // Only for names and what may be added: a catalog slow to answer, or
    // refused, leaves integrations by their IDs and nothing to add.
    catalogOrNone(session),
  ]);
  return { integrations, catalog };
};

/** The App's declared resources and their bindings, and the connections an admin names them by. */
const readResources =
  (decides: boolean) =>
  async (session: Session, app: string): Promise<ResourcesPage> => {
    const [review, connections] = await Promise.all([
      session.resourceBindings.review(app),
      decides ? session.connections.list() : [],
    ]);
    return { review, connections };
  };

const readResourcesAsAdmin = readResources(true);
const readResourcesAsBuilder = readResources(false);

const Connections = ({
  app,
  identity,
  builds,
}: {
  app: ViewedApp;
  identity: Identity;
  builds: boolean;
}) => {
  const decides = decidesRequests(identity);
  const declared = useAppRead(app.id, readDeclared);
  const used = useAppRead(app.id, readUsed);
  const resources = useAppRead(
    app.id,
    decides ? readResourcesAsAdmin : readResourcesAsBuilder
  );
  return (
    <div className="flex flex-col gap-8">
      <RefreshFailed reads={[declared, used, resources]} />
      <Read notedAbove read={declared}>
        {({ integrations, catalog }) => (
          <AppIntegrations
            app={app}
            builds={builds}
            catalog={catalog}
            integrations={integrations}
          />
        )}
      </Read>
      <section aria-labelledby="app-used" className="flex flex-col gap-3">
        <h3 className="font-medium" id="app-used">
          <Trans>Connections in use</Trans>
        </h3>
        <Read notedAbove read={used}>
          {({ integrations, http }) =>
            integrations.length === 0 && http.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>This App doesn&apos;t use a connection yet.</Trans>
              </p>
            ) : (
              <>
                {integrations.length === 0 ? null : (
                  <div className="@container">
                    <ul className="grid grid-cols-1 gap-x-10 @2xl:grid-cols-2">
                      {integrations.map((integration) => (
                        <IntegrationRow
                          identity={identity}
                          integration={integration}
                          key={integration.key}
                        />
                      ))}
                    </ul>
                  </div>
                )}
                {http.length === 0 ? null : (
                  <ul className="flex flex-col gap-3">
                    {http.map((listed) => (
                      // Revoked from Integrations, never from an App.
                      <HttpConnectionItem
                        heading="h4"
                        key={listed.connection.id}
                        listed={listed}
                        manages={false}
                      />
                    ))}
                  </ul>
                )}
              </>
            )
          }
        </Read>
      </section>
      <AppAccessRequests app={app} identity={identity} />
      <Read notedAbove read={resources}>
        {(page) => <ResourceBindings decides={decides} page={page} />}
      </Read>
      <AppWorkflows app={app} identity={identity} />
    </div>
  );
};

// --- Webhooks ------------------------------------------------------------

const readWebhooks = async (session: Session, app: string) =>
  await session.apps.webhooks.list(app);

const Webhooks = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Identity;
}) => {
  const read = useAppRead(app.id, readWebhooks);
  return (
    <AppWebhooks app={app.id}>
      <Read read={read}>
        {(listed) => <WebhookList identity={identity} webhooks={listed} />}
      </Read>
    </AppWebhooks>
  );
};

// --- Options -------------------------------------------------------------

const readSurfaces = async (session: Session, app: string) =>
  await session.pages.surfaces(app);

/** The App's settings surface (spec 34.1), if it declares one. */
const optionsOf = (
  surfaces: Loaded<SurfaceSummary[]> | undefined
): SurfaceSummary | undefined =>
  surfaces?.state === "ready"
    ? surfaces.data.find(({ kind }) => kind === "settings")
    : undefined;

/**
 * The App's own settings: its pages, at its settings surface's route,
 * with the person's own access and no more. Its router moves within the
 * frame; the settings page stays where it is.
 */
const Options = ({
  app,
  surface,
}: {
  app: string;
  surface: SurfaceSummary;
}) => (
  <div className="flex min-h-96 flex-col">
    <PageFrame app={app} at={surface.path} embedded key={surface.path} />
  </div>
);

// --- The settings --------------------------------------------------------

/** The sections `identity` sees of `app`, with Options once core says it declares them. */
const shownSections = (
  app: ViewedApp,
  identity: Identity,
  { options }: { options: boolean }
): AppSettingsSection[] => {
  const builder = app.role === "builder";
  const shown: Record<AppSettingsSection, boolean> = {
    general: true,
    sharing: true,
    // Core lists versions and webhooks to its builders alone.
    history: builder,
    connections: canBuild(identity.role),
    webhooks: builder,
    options,
  };
  return appSettingsSections.filter((section) => shown[section]);
};

/** Options: the App's own settings page, once core says it declares one. */
const OptionsSection = ({
  app,
  options,
}: {
  app: string;
  options: Loaded<SurfaceSummary[]> | undefined;
}) => {
  const { t } = useLingui();
  const surface = optionsOf(options);
  if (surface !== undefined) {
    return <Options app={app} surface={surface} />;
  }
  if (options === undefined) {
    return <LoadingLines />;
  }
  return options.state === "ready" ? (
    <p className="text-muted-foreground">{t`This App offers no options.`}</p>
  ) : (
    <NotLoaded page={options} />
  );
};

const SectionBody = ({
  section,
  app,
  identity,
  builds,
  options,
}: {
  section: AppSettingsSection;
  app: ViewedApp;
  identity: Identity;
  builds: boolean;
  options: Loaded<SurfaceSummary[]> | undefined;
}) => {
  if (section === "general") {
    return <General app={app} builds={builds} identity={identity} />;
  }
  if (section === "sharing") {
    return <Sharing app={app} identity={identity} />;
  }
  if (section === "history") {
    return (
      <DraftHistory
        builds={builds && !app.archived}
        identity={identity}
        live={app.currentVersion}
        subject={{ kind: "app", id: app.id }}
      />
    );
  }
  if (section === "connections") {
    return <Connections app={app} builds={builds} identity={identity} />;
  }
  if (section === "webhooks") {
    return <Webhooks app={app} identity={identity} />;
  }
  return <OptionsSection app={app.id} options={options} />;
};

const sectionDescriptions = {
  sharing: msg`Who opens the App besides you, and as what.`,
  history: msg`What changed, unpublished and published, which version is live, and going back to one.`,
  connections: msg`The integrations, connections and resources the App uses, and asking for more.`,
  webhooks: msg`Where Grasp sends the App's events.`,
  options: msg`The settings the App offers itself.`,
} satisfies Partial<Record<AppSettingsSection, MessageDescriptor>>;

/** A section's link in the list: the workspace's or the settings page's. */
const SectionLink = ({
  app,
  section,
  current,
  within,
  children,
}: {
  app: string;
  section: AppSettingsSection;
  current: boolean;
  within: "workspace" | "page";
  children: ReactNode;
}) => {
  const className = `${buttonVariants({
    size: "sm",
    variant: current ? "secondary" : "ghost",
  })} w-full md:justify-start`;
  const marked = current ? ("page" as const) : undefined;
  return within === "workspace" ? (
    <Link
      aria-current={marked}
      className={className}
      params={{ app }}
      replace
      search={(held) => ({
        chat: held.chat,
        env: held.env,
        project: held.project,
        view: "settings",
        section,
      })}
      to="/apps/$app"
    >
      {children}
    </Link>
  ) : (
    <Link
      aria-current={marked}
      className={className}
      params={{ app }}
      replace
      search={{ section }}
      to="/apps/$app/settings"
    >
      {children}
    </Link>
  );
};

/**
 * An App's settings: the sections `identity` sees as a list, and the one
 * open (`section`, or General) beside it, `within` the App's workspace or
 * on its settings page.
 */
export const AppSettings = ({
  app,
  identity,
  section: asked,
  within,
}: {
  app: ViewedApp;
  identity: Identity;
  section: AppSettingsSection | undefined;
  within: "workspace" | "page";
}) => {
  const { t, i18n } = useLingui();
  const builds = buildsApp(app, identity);
  const surfaces = useAppRead(app.id, readSurfaces);
  const sections = shownSections(app, identity, {
    options: optionsOf(surfaces) !== undefined,
  });
  // A section asked for by an address: there for whoever opens it.
  // Options waits on whether the App declares them; anything else opens
  // General.
  const section = asked ?? "general";
  const title = i18n._(sectionLabels[section]);
  const description =
    section === "general" ? undefined : i18n._(sectionDescriptions[section]);
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label={t`Settings sections`}
        className="flex flex-none gap-1 overflow-x-auto border-b p-2 md:w-52 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:p-3"
      >
        {sections.map((each) => (
          <span className="flex-none" key={each}>
            <SectionLink
              app={app.id}
              current={each === section}
              section={each}
              within={within}
            >
              {i18n._(sectionLabels[each])}
            </SectionLink>
          </span>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8">
          <SectionHeading description={description} title={title} />
          <SectionBody
            app={app}
            builds={builds}
            identity={identity}
            key={`${app.id}/${section}`}
            options={surfaces}
            section={section}
          />
        </div>
      </div>
    </div>
  );
};
