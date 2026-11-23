import { appLimits } from "@grasp-os/shared/app-limits";
import type {
  App,
  AppAnswerer,
  AppChanges,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type { OfferedCatalog } from "@grasp-os/shared/connect";
import type { SurfaceSummary } from "@grasp-os/shared/pages";
import { canBuild, isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { SubjectMember } from "@grasp-os/shared/subject-members";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import { ArchiveIcon, Icon, LinkIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactElement } from "react";

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
import { readPeople } from "../directory.ts";
import { DraftHistory } from "../drafts/draft-history.tsx";
import { Sharing } from "../drafts/sharing.tsx";
import { StatusBadge } from "../drafts/status-badge.tsx";
import { formatDateTime } from "../format.ts";
import { WithInfo } from "../frame/info-tip.tsx";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import { SavedField } from "../frame/saved-field.tsx";
import { decidesRequests } from "../inbox/waiting.ts";
import type { Loaded } from "../load-from-core.tsx";
import { PageFrame } from "../pages/page-frame.tsx";
import { InstructionFileEditor } from "../settings/instruction-file.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AppAccessRequests } from "./app-access-requests.tsx";
import { ExportDefinition } from "./app-definition.tsx";
import { AppIntegrations } from "./app-integrations.tsx";
import { AppLinkDialog, linkAddress } from "./app-own-link.tsx";
import { AppOwner } from "./app-owner.tsx";
import { RemoveApp } from "./app-remove.tsx";
import { ResetAppData } from "./app-reset.tsx";
import { buildsApp, sharesApp } from "./app-role.ts";
import { ArchiveDialog, StatusNote, useStatusMove } from "./app-status.tsx";
import { AppWebhooks, WebhookList } from "./app-webhooks.tsx";
import { AppWorkflows } from "./app-workflows.tsx";
import { SaveAsBlueprint } from "./blueprints.tsx";
import { ResourceBindings } from "./resource-bindings.tsx";
import type { ResourcesPage } from "./resource-bindings.tsx";
import {
  optionsOf,
  readSurfaces,
  sectionLabels,
  shownSections,
} from "./settings-sections.ts";
import type { AppSettingsSection } from "./settings-sections.ts";
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
  const { t } = useLingui();
  const failed = reads.flatMap((read) => read?.refresh ?? []);
  const [first] = failed;
  if (first === undefined) {
    return null;
  }
  return (
    <Alert variant="warning" appearance="banner">
      <AlertTitle>{t`Couldn't refresh. This may be out of date.`}</AlertTitle>
      <AlertAction>
        <Button
          onClick={() => {
            for (const { retry } of failed) {
              retry();
            }
          }}
          size="xs"
          variant="outline"
        >
          {t`Try again`}
        </Button>
      </AlertAction>
    </Alert>
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
    // The section reads again as the router does (useAppRead): Try again's own.
    return <NotLoadedState heading="h3" page={read} />;
  }
  return (
    <>
      {notedAbove ? null : <RefreshFailed reads={[read]} />}
      {children(read.data)}
    </>
  );
};

// How wide a section's column grows: Damsko has no token for a
// settings page's measure.
const SETTINGS_MEASURE = "56rem";
const INTEGRATION_MIN = "20rem";
// How tall the App's own settings stand at least, so its page has room.
const OPTIONS_TALL = "24rem";

const styles = stylex.create({
  settings: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    gap: space[2],
    paddingTop: space[2],
  },
  scroll: { flexGrow: 1, minHeight: 0, minWidth: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: space[4],
    width: "100%",
    maxWidth: SETTINGS_MEASURE,
    marginInline: "auto",
    paddingBlock: space[6],
    paddingInline: space[4],
    boxSizing: "border-box",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: space[2],
  },
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[3],
    minWidth: 0,
  },
  fact: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space[1],
  },
  sections: { display: "flex", flexDirection: "column", gap: space[8] },
  section: { display: "flex", flexDirection: "column", gap: space[3] },
  // Two columns once there is room for both: Damsko has no token for a
  // list item's measure.
  integrations: {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fill, minmax(min(${INTEGRATION_MIN}, 100%), 1fr))`,
    columnGap: space[10],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  options: {
    display: "flex",
    flexDirection: "column",
    minHeight: OPTIONS_TALL,
  },
});

// --- General -------------------------------------------------------------

/** Nobody in particular, as the "Made for" picker's value. */
const nobody = "nobody";

/** A member reference as one picker value: `person:<id>` or `team:<id>`. */
const refValue = ({ type, id }: { type: string; id: string }): string =>
  `${type}:${id}`;

/** Archive (asking first) or Restore, for its builders. */
const PuttingAway = ({ app }: { app: App }) => {
  const { t } = useLingui();
  const { busy, failure, move } = useStatusMove(app.id);
  const [archiving, setArchiving] = useState(false);
  const { archived } = app;
  return (
    <div {...stylex.props(styles.actions)}>
      {archived ? (
        <Button
          disabled={busy}
          onClick={() => {
            move("restore");
          }}
          variant="outline"
        >
          {t`Restore`}
        </Button>
      ) : (
        <Button
          disabled={busy}
          onClick={() => {
            setArchiving(true);
          }}
          variant="outline"
        >
          <Icon icon={ArchiveIcon} />
          {app.currentVersion === null
            ? t`Archive`
            : t`Archive and take offline`}
        </Button>
      )}
      {failure === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
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
  members: SubjectMember[];
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
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <div {...stylex.props(styles.line)}>
      <Text as="span" size="sm" color="muted">
        {app.link === null ? t`None yet` : linkAddress(app.link)}
      </Text>
      <Button
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <Icon icon={LinkIcon} />
        {t`Set the link`}
      </Button>
      <AppLinkDialog app={app} onOpenChange={setOpen} open={open} />
    </div>
  );
};

/** The App's instruction file, as its builders read it to edit. */
const readAppInstructions = async (session: Session, app: string) =>
  await session.instructions.read({ scope: "app", appId: app });

/** What chats about the App start with, for its builders to change. */
const AppInstructions = ({ app }: { app: ViewedApp }) => {
  const { t } = useLingui();
  const read = useAppRead(app.id, readAppInstructions);
  return (
    <Card asChild>
      <section aria-label={t`Instructions`}>
        <CardHeader>
          <WithInfo
            info={t`What a builder’s chat about this App starts with. Only its builders read and change it.`}
            label={t`More about its instructions`}
          >
            <CardTitle>{t`Instructions`}</CardTitle>
          </WithInfo>
        </CardHeader>
        <CardContent>
          <Read read={read}>
            {(saved) => (
              <InstructionFileEditor
                description={t`How this App is built and what to keep in mind when changing it.`}
                file={{ scope: "app", appId: app.id }}
                label={t`Instructions for this App`}
                saved={saved}
              />
            )}
          </Read>
        </CardContent>
      </section>
    </Card>
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
      {/* Archived, it is read-only: its file waits for a restore. */}
      {app.archived ? null : <AppInstructions app={app} />}
      <Card asChild>
        <section aria-label={t`Copies`}>
          <CardHeader>
            <WithInfo
              info={t`Its definition to keep or move, and a blueprint others can start from.`}
              label={t`More about copies`}
            >
              <CardTitle>{t`Copies`}</CardTitle>
            </WithInfo>
          </CardHeader>
          <CardContent>
            <div {...stylex.props(styles.actions)}>
              <ExportDefinition app={app} identity={identity} />
              {canBuild(identity.role) && currentVersion !== null ? (
                <SaveAsBlueprint
                  app={app.id}
                  name={app.name}
                  version={currentVersion}
                />
              ) : null}
              {currentVersion === null ? (
                <Text size="sm" color="muted">
                  {t`Once it has a version, it can be copied.`}
                </Text>
              ) : null}
            </div>
          </CardContent>
        </section>
      </Card>
      {app.archived || identity.staff || !isAdmin(identity.role) ? null : (
        <Card asChild>
          <section aria-label={t`Its data`}>
            <CardHeader>
              <WithInfo
                info={t`Only an admin resets an App’s data: every record goes for good, and its current version runs again with no records.`}
                label={t`More about its data`}
              >
                <CardTitle>{t`Its data`}</CardTitle>
              </WithInfo>
            </CardHeader>
            <CardContent>
              <ResetAppData app={app} />
            </CardContent>
          </section>
        </Card>
      )}
      <Card asChild>
        <section aria-label={t`Putting it away`}>
          <CardHeader>
            <WithInfo
              info={t`An archived App is kept as it was and goes offline: nobody opens it, its triggers stop and its unfinished runs are cancelled. A builder can restore it, as a draft.`}
              label={t`More about putting it away`}
            >
              <CardTitle>{t`Putting it away`}</CardTitle>
            </WithInfo>
          </CardHeader>
          <CardContent>
            {/* Archive or Restore, then Delete under it, a step apart. */}
            <div {...stylex.props(styles.section)}>
              <PuttingAway app={app} />
              <RemoveApp app={app} identity={identity} />
            </div>
          </CardContent>
        </section>
      </Card>
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
  const nameOf = (member: SubjectMember): string =>
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
      <Text size="sm" color="muted">
        {person === undefined
          ? t`Made on ${date}.`
          : t`Made by ${person} on ${date}.`}
      </Text>
      <Card asChild>
        <section aria-label={t`About`}>
          <CardHeader>
            <CardTitle>{t`About`}</CardTitle>
          </CardHeader>
          <CardContent flush>
            <FieldGroup>
              <Field orientation="responsive">
                <FieldContent>
                  <FieldLabel>{t`Name`}</FieldLabel>
                </FieldContent>
                <SavedField
                  maxLength={appLimits.nameLength}
                  onSave={(name) => {
                    // A name can't be emptied.
                    if (name !== null) {
                      change({ name });
                    }
                  }}
                  readOnly={!builds || busy}
                  value={app.name}
                />
              </Field>
              <Field orientation="responsive">
                <FieldContent>
                  <FieldLabel>
                    {t({
                      message: "What it is for",
                      context: "what an app is for, in a sentence",
                    })}
                  </FieldLabel>
                </FieldContent>
                <SavedField
                  maxLength={appLimits.descriptionLength}
                  multiline
                  onSave={(description) => {
                    change({ description: description ?? "" });
                  }}
                  readOnly={!builds || busy}
                  value={app.description}
                />
              </Field>
              <Field orientation="responsive">
                <FieldContent>
                  <FieldTitle>{t`Status`}</FieldTitle>
                </FieldContent>
                <div {...stylex.props(styles.fact)}>
                  <StatusBadge
                    archived={app.archived}
                    live={app.currentVersion}
                  />
                  <StatusNote app={app} />
                </div>
              </Field>
              <Field orientation="responsive">
                <FieldContent>
                  <WithInfo
                    info={t`Shown with the App. It opens the App to nobody: who may use it is who it is shared with.`}
                  >
                    <FieldLabel>{t`Made for`}</FieldLabel>
                  </WithInfo>
                </FieldContent>
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
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </Field>
              {builds && !app.archived ? (
                <Field orientation="responsive">
                  <FieldContent>
                    <FieldTitle>{t`Link`}</FieldTitle>
                  </FieldContent>
                  <OwnLink app={app} />
                </Field>
              ) : null}
              {failure === undefined ? null : (
                <Alert variant="destructive">
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              )}
            </FieldGroup>
          </CardContent>
        </section>
      </Card>
      <Card asChild>
        <section
          aria-label={t({
            message: "Owner",
            context: "who answers for an app",
          })}
        >
          <CardHeader>
            <WithInfo
              info={t`Who answers for the App: who is asked about it and decides what changes.`}
              label={t`More about the owner`}
            >
              <CardTitle>
                {t({ message: "Owner", context: "who answers for an app" })}
              </CardTitle>
            </WithInfo>
          </CardHeader>
          <CardContent>
            {/* The platform's one owner control, as a workflow's line has it. */}
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
          </CardContent>
        </section>
      </Card>
      {builds ? (
        <ForBuilders app={app} identity={identity} />
      ) : (
        <Text size="sm" color="muted">
          {t`Only its builders change these settings.`}
        </Text>
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

const AppSharing = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Identity;
}) => (
  <Sharing
    editable={sharesApp(app, identity)}
    identity={identity}
    owner={app.owner}
    subject={{ kind: "app", id: app.id }}
  />
);

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
    <div {...stylex.props(styles.sections)}>
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
      <section aria-labelledby="app-used" {...stylex.props(styles.section)}>
        <Heading id="app-used" level={3} size="xs">
          <Trans>Connections in use</Trans>
        </Heading>
        <Read notedAbove read={used}>
          {({ integrations, http }) =>
            integrations.length === 0 && http.length === 0 ? (
              <Text size="sm" color="muted">
                <Trans>This App doesn&apos;t use a connection yet.</Trans>
              </Text>
            ) : (
              <>
                {integrations.length === 0 ? null : (
                  <div>
                    <ul {...stylex.props(styles.integrations)}>
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
                  <ul {...stylex.props(styles.list)}>
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
  <div {...stylex.props(styles.options)}>
    <PageFrame app={app} at={surface.path} embedded key={surface.path} />
  </div>
);

// --- The settings --------------------------------------------------------

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
    <Text size="sm" color="muted">
      {t`This App offers no options.`}
    </Text>
  ) : (
    <NotLoadedState heading="h3" page={options} />
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
    return <AppSharing app={app} identity={identity} />;
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

/** A section's tab: the workspace's address or the settings page's. */
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
  children: string;
}) => (
  <TabsLink asChild current={current}>
    {within === "workspace" ? (
      <Link
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
        params={{ app }}
        replace
        search={{ section }}
        to="/apps/$app/settings"
      >
        {children}
      </Link>
    )}
  </TabsLink>
);

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
  return (
    <div {...stylex.props(styles.settings)}>
      <TabsNav aria-label={t`Settings sections`} variant="line">
        {sections.map((each) => (
          <SectionLink
            app={app.id}
            current={each === section}
            key={each}
            section={each}
            within={within}
          >
            {i18n._(sectionLabels[each])}
          </SectionLink>
        ))}
      </TabsNav>
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.column)}>
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
