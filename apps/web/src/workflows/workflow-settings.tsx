import type { Identity } from "@grasp-os/shared/rpc";
import { workflowTitleMaxLength } from "@grasp-os/shared/workflow-resources";
import type {
  SteeredWrite,
  WorkflowDraft,
  WorkflowParams,
  WorkflowResource,
  WorkflowResourceVersion,
  WorkflowState,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { DraftHistory } from "../drafts/draft-history.tsx";
import { Sharing } from "../drafts/sharing.tsx";
import { formatList } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import type { Names } from "./activity-bar.tsx";
import { AskStephen } from "./ask-stephen.tsx";
import {
  ProcessBadge,
  ProcessPicker,
  processCovers,
} from "./business-process.tsx";
import { DefinitionEditor } from "./definition-editor.tsx";
import { DeleteWorkflow } from "./delete-workflow.tsx";
import { FilesAndApps } from "./files-and-apps.tsx";
import { InfoTip, LabelWithInfo } from "./info-tip.tsx";
import { KeptState } from "./kept-state.tsx";
import { ResourceParams } from "./resource-params.tsx";
import { SavedAgo } from "./saved-ago.tsx";
import { SectionCard } from "./section-card.tsx";
import { workflowSettingsSections } from "./settings-sections.ts";
import type { WorkflowSettingsSection } from "./settings-sections.ts";
import { VersionSource } from "./version-source.tsx";
import { WorkflowTriggers } from "./workflow-triggers.tsx";

// Everything about a workflow besides its Flow and its runs, in one place,
// a section at a time, as an App's settings are (apps/app-settings.tsx):
// what it serves and whose it is (General), whom it is shared with and as
// what (Sharing), what starts it on its own (Triggers), the files its runs
// wrote and the apps and Brain it works in (Files and apps), its
// parameters and what it keeps between runs (Parameters), the JSON behind
// its Flow, for its builders (Definition), and its changes and published
// versions, as an App's History has them (drafts/draft-history.tsx). Each
// section is an address of its own (`?section=`).

const sectionLabels: Record<WorkflowSettingsSection, MessageDescriptor> = {
  general: msg({
    message: "General",
    context: "a workflow's settings section",
  }),
  sharing: msg({
    message: "Sharing",
    context: "a workflow's settings section",
  }),
  triggers: msg({
    message: "Triggers",
    context: "a workflow's settings section",
  }),
  files: msg({
    message: "Files and apps",
    context: "a workflow's settings section",
  }),
  parameters: msg({
    message: "Parameters",
    context: "a workflow's settings section",
  }),
  definition: msg({
    message: "Definition",
    context: "a workflow's settings section",
  }),
  history: msg({
    message: "History",
    context: "a workflow's settings section",
  }),
};

// How wide a section's column grows, as an App's settings have it
// (apps/app-settings.tsx): Damsko has no token for a settings page's
// measure.
const SETTINGS_MEASURE = "56rem";

const styles = stylex.create({
  settings: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    gap: space["2"],
    paddingTop: space["2"],
    // The room at its sides the reference's shell gives it: the frame's
    // item shell gives none of its own.
    paddingInline: space["6"],
  },
  scroll: { flexGrow: 1, minHeight: 0, minWidth: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: space["4"],
    width: "100%",
    maxWidth: SETTINGS_MEASURE,
    marginInline: "auto",
    paddingBlock: space["6"],
    paddingInline: space["4"],
    boxSizing: "border-box",
  },
  writes: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["1"],
  },
  // A fact's name and its info mark on one line.
  fact: { display: "flex", alignItems: "center", gap: space["1"] },
  control: { width: "100%" },
});

/**
 * What a version's model tasks may steer (GRA-718, GRA-727), which no
 * reviewer should have to piece together: each connector's alias and the
 * operations that may write.
 */
const SteeredWrites = ({ writes }: { writes: readonly SteeredWrite[] }) => (
  <span {...stylex.props(styles.writes)}>
    {writes.map((write) => (
      <Badge key={write.alias} size="sm" variant="warning">
        {`${write.alias}: ${formatList(write.operations)}`}
      </Badge>
    ))}
  </span>
);

/**
 * What a version's model tasks may steer, under it in History (GRA-718,
 * GRA-727). A version an earlier platform release published, in a format
 * this one doesn't read (`refused`), never runs: it says so, and to
 * publish it again, in place of a review of a build it doesn't have.
 */
const VersionDetails = ({ version }: { version: WorkflowResourceVersion }) => {
  const { t } = useLingui();
  if (version.refused !== undefined) {
    return (
      <span>
        <Badge size="sm" variant="warning">
          {t`Made by an earlier platform release: publish it again`}
        </Badge>
      </span>
    );
  }
  return version.modelSteeredWrites.length === 0 ? null : (
    <span {...stylex.props(styles.writes)}>
      <Text as="span" color="muted" size="sm">
        {t`Writes a model may steer:`}
      </Text>
      <SteeredWrites writes={version.modelSteeredWrites} />
    </span>
  );
};

/**
 * Whom the workflow belongs to: you, or its owner by name; someone else
 * while their name isn't known (not listed, or not read yet), never an ID.
 */
const OwnedBy = ({ owner, names }: { owner: string; names: Names }) => {
  const { t } = useLingui();
  if (owner === names.me) {
    return t`Owned by you`;
  }
  const name = names.people.get(owner);
  return name === undefined ? t`Owned by someone else` : t`Owned by ${name}`;
};

/** What a title is saved as: its text, trimmed; null when emptied. */
const savedAs = (draft: string): string | null => {
  const trimmed = draft.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * The title's field, saved as the person leaves it or presses Enter, as
 * the workspace's name is: emptied, it saves none; Escape puts back what
 * was saved; nothing is sent while it is what was saved.
 */
const TitleInput = ({
  value,
  readOnly,
  onSave,
}: {
  value: string | null;
  readOnly: boolean;
  onSave: (value: string | null) => void;
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const save = (): void => {
    if (draft === null) {
      return;
    }
    setDraft(null);
    const next = savedAs(draft);
    if (next !== value) {
      onSave(next);
    }
  };
  return (
    <Input
      maxLength={workflowTitleMaxLength}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(null);
        }
      }}
      onValueChange={setDraft}
      readOnly={readOnly}
      size="sm"
      style={styles.control}
      value={draft ?? value ?? ""}
    />
  );
};

/**
 * The name people see for the workflow, as its builders give it: saved as
 * the field is left, and emptied to show its own name again. Core checks
 * they may, and audits it.
 */
const TitleRow = ({
  resource,
  name,
}: {
  resource: Pick<WorkflowResource, "id" | "title">;
  /** Its own name, which shows while it has no title. */
  name: string;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const save = async (title: string | null): Promise<void> => {
    const changed = await run(
      async (session) =>
        await session.workflowResources.setTitle(resource.id, title)
    );
    if (changed !== undefined) {
      void router.invalidate();
    }
  };
  return (
    <Field
      orientation="responsive"
      {...(failure === undefined ? {} : { "data-invalid": true })}
    >
      <FieldContent>
        <FieldLabel>{t`Name`}</FieldLabel>
        <FieldDescription>{t`What people see instead of ${name}.`}</FieldDescription>
        {failure === undefined ? null : <FieldError>{failure}</FieldError>}
      </FieldContent>
      <TitleInput
        onSave={(title) => {
          void save(title);
        }}
        readOnly={busy}
        value={resource.title}
      />
    </Field>
  );
};

/** A fact about the workflow, in a row of its settings: its name, and what it is. */
const FactRow = ({
  label,
  info,
  children,
}: {
  label: string;
  info?: string | undefined;
  children: ReactNode;
}) => (
  <Field orientation="responsive">
    <FieldContent>
      <span {...stylex.props(styles.fact)}>
        <FieldTitle>{label}</FieldTitle>
        {info === undefined ? null : <InfoTip>{info}</InfoTip>}
      </span>
    </FieldContent>
    {/* Where the rows' controls stand, from the start of their column. */}
    <Text as="span" size="sm" style={styles.control}>
      {children}
    </Text>
  </Field>
);

/** What the workflow's page read, and what changes it, as its sections need. */
interface WorkflowRead {
  resource: WorkflowResource;
  /** Its draft, for its builders alone. */
  draft: Loaded<WorkflowDraft> | undefined;
  /** The draft the page goes by: its editor's last save, or the page's read. */
  latest: WorkflowDraft | undefined;
  /** Takes what a save of the draft left. */
  onDraft: (next: WorkflowDraft) => void;
  /** When its draft was last saved, for its builders. */
  savedAt: string | null;
  versions: Loaded<WorkflowResourceVersion[]>;
  params: Loaded<WorkflowParams>;
  /** What it keeps between runs, for its builders and admins only. */
  state: Loaded<WorkflowState> | undefined;
  askable: Loaded<boolean>;
  names: Names;
  /** Who reads it: what History offers them. */
  identity: Pick<Identity, "userId" | "role" | "staff">;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
  /** Whether they approve its bindings: an admin of its own, not Grasp staff. */
  approves: boolean;
}

/** The business process it serves: its builders pick it, anyone else reads it. */
const ProcessRow = ({
  resource,
  builder,
}: {
  resource: WorkflowResource;
  builder: boolean;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const { process } = resource;
  const covers = process === null ? undefined : i18n._(processCovers[process]);
  if (builder) {
    return (
      <Field orientation="responsive">
        <FieldContent>
          {covers === undefined ? (
            <FieldLabel>{t`Business process`}</FieldLabel>
          ) : (
            <LabelWithInfo info={covers} label={t`Business process`} />
          )}
        </FieldContent>
        <ProcessPicker
          name={resource.name}
          onChange={() => {
            void router.invalidate();
          }}
          process={process}
          workflow={resource.id}
        />
      </Field>
    );
  }
  return (
    <FactRow info={covers} label={t`Business process`}>
      {process === null ? t`None` : <ProcessBadge process={process} />}
    </FactRow>
  );
};

/** General: what it serves, whose it is, and deleting it. */
const General = ({
  resource,
  savedAt,
  askable,
  names,
  admin,
}: WorkflowRead) => {
  const { t } = useLingui();
  const builder = resource.role === "builder";
  const owner = resource.owner === names.me;
  const { name } = resource;
  return (
    <>
      <SectionCard flush title={t`About`}>
        <FieldGroup>
          {builder ? <TitleRow name={name} resource={resource} /> : null}
          <ProcessRow builder={builder} resource={resource} />
          <FactRow label={t`Owner`}>
            <OwnedBy names={names} owner={resource.owner} />
          </FactRow>
          {savedAt === null ? null : (
            <FactRow label={t`Draft`}>
              <SavedAgo at={savedAt} />
            </FactRow>
          )}
        </FieldGroup>
      </SectionCard>
      {owner && askable.state === "ready" ? (
        <SectionCard flush title={t`Stephen`}>
          <AskStephen askable={askable.data} workflow={resource.id} />
        </SectionCard>
      ) : null}
      <DeleteWorkflow admin={admin} resource={resource} />
    </>
  );
};

/** The section open: what it shows of the workflow. */
const SectionBody = ({
  section,
  read,
}: {
  section: WorkflowSettingsSection;
  read: WorkflowRead;
}) => {
  const { resource, names, approves, versions, identity } = read;
  const builder = resource.role === "builder";
  const { currentVersion } = resource;
  if (section === "sharing") {
    return (
      <Sharing
        editable={builder && !identity.staff}
        identity={{ userId: names.me }}
        owner={resource.owner}
        subject={{ kind: "workflow", id: resource.id }}
      />
    );
  }
  if (section === "triggers") {
    return (
      <WorkflowTriggers
        builder={builder}
        me={names.me}
        workflow={resource.id}
      />
    );
  }
  if (section === "files") {
    return (
      <FilesAndApps
        approves={approves}
        currentVersion={currentVersion}
        names={names}
        versions={versions}
        workflow={resource.id}
      />
    );
  }
  if (section === "parameters") {
    return (
      <>
        {read.params.state === "ready" ? (
          <ResourceParams
            editable={builder}
            loaded={read.params.data}
            workflow={resource.id}
          />
        ) : (
          <NotLoadedState page={read.params} />
        )}
        <KeptState
          editable={builder || approves}
          read={read.state}
          workflow={resource.id}
        />
      </>
    );
  }
  if (section === "definition" && read.draft !== undefined) {
    return read.draft.state === "ready" ? (
      <DefinitionEditor
        loaded={read.latest ?? read.draft.data}
        onDraft={(next) => {
          read.onDraft(next);
        }}
        workflow={resource.id}
      />
    ) : (
      <NotLoadedState page={read.draft} />
    );
  }
  if (section === "history") {
    return (
      <>
        <DraftHistory
          builds={builder && !identity.staff}
          renderDetails={(version) =>
            version.kind === "workflow" ? (
              <VersionDetails version={version} />
            ) : null
          }
          identity={identity}
          live={currentVersion}
          subject={{ kind: "workflow", id: resource.id }}
        />
        <VersionSource
          builder={builder}
          versions={versions}
          workflow={resource.id}
        />
      </>
    );
  }
  return <General {...read} />;
};

/** A section's link in the list, an address of its own. */
const SectionLink = ({
  workflow,
  section,
  current,
  children,
}: {
  workflow: string;
  section: WorkflowSettingsSection;
  current: boolean;
  children: string;
}) => (
  <TabsLink asChild current={current}>
    <Link
      params={{ workflow }}
      replace
      search={(held) => ({
        project: held.project,
        view: "settings",
        section,
      })}
      to="/workflows/$workflow"
    >
      {children}
    </Link>
  </TabsLink>
);

/**
 * A workflow's settings: the sections the reader sees as a list, and the
 * one open (`section`, or General) beside it. Sharing and Definition are
 * its builders' alone, who read its draft.
 */
export const WorkflowSettings = ({
  section: asked,
  read,
}: {
  section: WorkflowSettingsSection | undefined;
  read: WorkflowRead;
}) => {
  const { t, i18n } = useLingui();
  const sections = workflowSettingsSections.filter(
    (each) =>
      (each !== "definition" && each !== "sharing") || read.draft !== undefined
  );
  const section =
    asked === undefined || !sections.includes(asked) ? "general" : asked;
  return (
    <div {...stylex.props(styles.settings)}>
      <TabsNav aria-label={t`Settings sections`} variant="line">
        {sections.map((each) => (
          <SectionLink
            current={each === section}
            key={each}
            section={each}
            workflow={read.resource.id}
          >
            {i18n._(sectionLabels[each])}
          </SectionLink>
        ))}
      </TabsNav>
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.column)}>
          <SectionBody read={read} section={section} />
        </div>
      </div>
    </div>
  );
};
