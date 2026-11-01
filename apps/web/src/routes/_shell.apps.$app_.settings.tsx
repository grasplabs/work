import { appLimits } from "@grasp-os/shared/app-limits";
import type {
  App,
  AppAnswerer,
  AppChanges,
  AppIntegration,
  AppMember,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type { OfferedCatalog } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
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
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArchiveIcon, ArrowLeftIcon, LayoutGridIcon } from "lucide-react";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { timeoutMs, withTimeout } from "../core.ts";
import type { Session } from "../core.ts";
import { readPeople } from "../directory.ts";
import { AppIntegrations } from "../engines/app-integrations.tsx";
import { AppOwner } from "../engines/app-owner.tsx";
import { buildsApp } from "../engines/app-role.ts";
import {
  ArchiveDialog,
  StatusBadge,
  useStatusMove,
} from "../engines/app-status.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsBody,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// An App's settings, a domain's as people read it (GRA-219) (grasplabs/prototype `components/apps/app-settings.tsx`):
// what it is called and what it is for, where it stands, who answers for it
// and whom it is made for, and putting it away. Its builders change them
// through core's audited calls (`apps.update`, `apps.archive`,
// `apps.restore`); anyone else who may open it reads them. Removing an App
// waits on core (GRA-1120); its integrations and webhooks are elsewhere.

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
  const archived = app.status === "archived";
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
          {app.status === "published" ? (
            <Trans>Archive and take offline</Trans>
          ) : (
            <Trans>Archive</Trans>
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

/**
 * Who may answer for App `app`, as read in time; null when it couldn't be
 * (refused, failed or slow), so the picker says so rather than offer
 * nobody else.
 */
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

const AppSettings = ({
  app,
  members,
  people,
  eligible,
  integrations,
  catalog,
  builds,
}: {
  app: ViewedApp;
  members: readonly AppMember[];
  people: ReadonlyMap<string, string>;
  /**
   * Who may answer for it, as core decides (`apps.answerers`); null while
   * that couldn't be read.
   */
  eligible: readonly AppAnswerer[] | null;
  integrations: readonly AppIntegration[];
  catalog: OfferedCatalog["entries"] | null;
  builds: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
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
  // Whom it may be made for: a person or team it is shared with.
  const current = app.audience === null ? nobody : refValue(app.audience);
  const audiences = [
    { value: nobody, label: t`Nobody in particular` },
    ...members.map((member) => ({
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
  const appName = app.name;
  const person = names.get(app.owner);
  const date = formatDateTime(app.createdAt);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 text-sm md:px-6">
      <div>
        <Link
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          params={{ app: app.id }}
          to="/apps/$app"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          <Trans>Back to {appName}</Trans>
        </Link>
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium tracking-tight">
          <Trans>Settings of {appName}</Trans>
        </h1>
        <p className="text-muted-foreground">
          {person === undefined ? (
            <Trans>Made on {date}.</Trans>
          ) : (
            <Trans>
              Made by {person} on {date}.
            </Trans>
          )}
        </p>
      </div>
      <SettingsSection
        description={t`What the domain is called and what it is for.`}
        title={t`General`}
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
          <StatusBadge status={app.status} />
        </SettingsRow>
        <SettingsRow
          description={t`Shown with the domain. It opens the domain to nobody: who may use it is who it is shared with.`}
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
              const member = members.find((each) => refValue(each) === value);
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
        {failure === undefined ? null : (
          <div className="border-t px-5 py-3">
            <ErrorText>{failure}</ErrorText>
          </div>
        )}
      </SettingsSection>
      <SettingsSection
        description={t`Who answers for the domain: who is asked about it and decides what changes.`}
        title={t({ message: "Owner", context: "who answers for an app" })}
      >
        {/* The platform's one owner control, as a workflow's line has it. */}
        <SettingsBody>
          <AppOwner
            // Who may answer for it, as core decides: those it is shared
            // with through a team too. Not read for someone who doesn't
            // build it, who only looks.
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
      <AppIntegrations
        app={app}
        builds={builds}
        catalog={catalog}
        integrations={integrations}
      />
      {builds ? (
        <SettingsSection
          description={t`An archived domain is kept as it was and goes offline: nobody opens it, its triggers stop and its unfinished runs are cancelled. A builder can restore it, as a draft.`}
          title={t`Putting it away`}
        >
          <PuttingAway app={app} />
        </SettingsSection>
      ) : (
        <p className="text-muted-foreground">
          <Trans>Only its builders change these settings.</Trans>
        </p>
      )}
    </div>
  );
};

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

const AppSettingsPage = () => {
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { t } = useLingui();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Domains`, to: "/domains" }, { label: t`Domain` }]}
        icon={LayoutGridIcon}
        notFound={t`Domain not found`}
        page={page}
      />
    );
  }
  const { app, members, people, answerers, integrations, catalog } = page.data;
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Domains`, to: "/domains" },
          { label: app.name },
          { label: t`Settings` },
        ]}
      />
      <AppSettings
        app={app}
        builds={buildsApp(app, identity)}
        eligible={answerers}
        members={members}
        people={people}
        integrations={integrations}
        catalog={catalog}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/$app_/settings")({
  pendingComponent: PageLoading,
  component: AppSettingsPage,
  loader: async ({ context: { core, identity }, params }) =>
    await loadFromCore(core, async (session) => {
      const [app, members, people, answerers, integrations, catalog] =
        await Promise.all([
          session.apps.get(params.app),
          session.apps.members.list(params.app),
          // Everyone's names only for an admin, who may list members.
          isAdmin(identity.role)
            ? readPeople(session)
            : Promise.resolve(new Map<string, string>()),
          // Who may answer for it, for its builders; null when that couldn't
          // be read in time, never an empty list mistaken for nobody else.
          answerersOrFailed(session, params.app),
          session.apps.integrations.list(params.app),
          // Only for names and what may be added: a catalog slow to answer
          // (Composio), or refused, leaves integrations by their IDs and
          // nothing to add, said so.
          catalogOrNone(session),
        ]);
      return { app, members, people, answerers, integrations, catalog };
    }),
});
