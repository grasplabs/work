import type { ListedConnection } from "@grasp-os/shared/connect";
import type {
  BindingChoices,
  BindingState,
  DeclaredResource,
  ResourceBinding,
  ResourceBindingsReview,
} from "@grasp-os/shared/resource-bindings";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { formatList } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import type { KeyValueItem } from "../grasp/key-value/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Separator } from "../grasp/separator/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  allChosen,
  firstChoice,
  formKey,
  noChoice,
  targetOf,
} from "./binding-form.ts";

// What an App's actions reach through its declared resources (core's
// resource-bindings.ts): the models, integrations and knowledge
// its current version declares, whether a binding serves each now and,
// when it doesn't, why. An admin binds each one to something that may
// serve it, and replaces or revokes a binding. Core decides who may (the organization's own admins, never
// Grasp staff or builders) and checks every choice again; the page only
// offers the controls to those core gives choices to.

/** An App's resources, with the connections an admin may name. */
export interface ResourcesPage {
  review: ResourceBindingsReview;
  /** The connections the viewer can see, to name connection permissions. */
  connections: ListedConnection[];
}

const kindLabels: Readonly<
  Record<DeclaredResource["kind"], MessageDescriptor>
> = {
  model: msg`AI`,
  connector: msg`Integration`,
  knowledge: msg`Brain`,
  grasp: msg`The platform's statistics`,
  guests: msg`Guests`,
};

const stateLabels: Readonly<Record<BindingState, MessageDescriptor>> = {
  served: msg`Bound`,
  unbound: msg`Not bound`,
  declaration_changed: msg`Not served`,
  contract_changed: msg`Not served`,
  grant_lost: msg`Not served`,
  unchecked: msg`Not checked`,
};

/** Why a binding no longer serves its resource, by its state. */
const stateReasons: Readonly<Partial<Record<BindingState, MessageDescriptor>>> =
  {
    unbound: msg`The App's actions can't use it until an admin binds it.`,
    declaration_changed: msg`The current version declares it differently from the version its binding was approved for. Bind it again to approve what it declares now.`,
    contract_changed: msg`What it is bound to has changed since the binding was approved. Bind it again once you've checked it still fits.`,
    grant_lost: msg`What it is bound to can't serve it any more: its permission was revoked, or the model is no longer allowed.`,
    unchecked: msg`The App has too many integrations to check them all on this page, so this binding wasn't checked. Its next request is checked as always.`,
  };

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  resource: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  badges: { display: "flex", flexWrap: "wrap", gap: grasp.space1 },
});

/** A change to what core holds, then the page read again. */
type Decide = (change: (session: Session) => Promise<unknown>) => Promise<void>;

/** What a resource's binding binds it to, named as far as the page can. */
const useBoundTo = () => {
  const { t } = useLingui();
  return (binding: NonNullable<DeclaredResource["binding"]>): string => {
    const { target, label } = binding;
    if (target.kind === "model") {
      return target.model;
    }
    if (target.kind === "guests" || target.kind === "grasp") {
      const { permissionId: permission } = target;
      return t`Permission ${permission}`;
    }
    if (target.kind === "connector") {
      // Core names the bound connection for everyone who reads the review,
      // while they can see it; its permission otherwise.
      const { permissionId: permission } = target;
      if (label.connection === null) {
        return t`Permission ${permission}`;
      }
      const { provider } = label.connection;
      const account = label.connection.account ?? provider;
      return t`${account} on ${provider}`;
    }
    return formatList(
      Object.entries(target.collections).map(([collection, permission]) => {
        const name = label.collections[collection] ?? permission;
        return t`${collection}: ${name}`;
      })
    );
  };
};

/** One labelled select, of `items`. */
const Choice = ({
  label,
  items,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  items: { value: string; label: string }[];
  /** The value chosen, or null for none yet. */
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
}) => (
  <Field>
    <FieldLabel>{label}</FieldLabel>
    <Select
      items={items}
      onValueChange={(chosen) => {
        if (chosen !== null) {
          onChange(chosen);
        }
      }}
      value={value}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent />
    </Select>
  </Field>
);

/** Why nothing can be chosen for a resource yet, by its kind. */
const NothingToChoose = ({
  resource,
  truncated,
}: {
  resource: DeclaredResource;
  truncated: boolean;
}) => {
  const { t } = useLingui();
  const { contract } = resource;
  if (truncated) {
    // Some were never checked: that none is listed doesn't mean none exists.
    return (
      <Text size="sm" tone="muted">
        {t`Not every choice could be checked, and none of those checked can serve it. Reload the page to check again.`}
      </Text>
    );
  }
  const reasons: Readonly<Record<DeclaredResource["kind"], string>> = {
    model: t`This deployment allows no model.`,
    connector: t`None of the App's integration permissions serves ${contract} with every action it declares. Grant one first.`,
    knowledge: t`The App has no permission to read a collection. Grant one first.`,
    grasp: t`The App has no permission to read the platform's statistics. Grant one first.`,
    guests: t`The App has no permission to invite guests. Grant one first.`,
  };
  return (
    <Text size="sm" tone="muted">
      {reasons[resource.kind]}
    </Text>
  );
};

/** The permissions a choice of the platform's or of guests offers, as a select's items. */
const permissionItems = (
  permissions: readonly { permissionId: string }[],
  name: (permission: string) => string
) =>
  permissions.map(({ permissionId }) => ({
    value: permissionId,
    label: name(permissionId),
  }));

/** An admin's choice of what serves `resource`, and the approval of it. */
const BindForm = ({
  app,
  version,
  resource,
  choices,
  connections,
  busy,
  decide,
}: {
  app: string;
  version: number;
  resource: DeclaredResource;
  choices: BindingChoices;
  connections: ListedConnection[];
  busy: boolean;
  decide: Decide;
}) => {
  const { t } = useLingui();
  const { alias, binding } = resource;
  const [picked, setPicked] = useState(() => firstChoice(choices));
  const [collections, setCollections] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      resource.collections.map((collection) => [
        collection,
        // Nothing chosen yet: each collection is chosen on purpose.
        "",
      ])
    )
  );
  if (noChoice(choices)) {
    return (
      <NothingToChoose resource={resource} truncated={choices.truncated} />
    );
  }
  // Every collection declared now needs its own choice before binding;
  // what is sent names those, and only those.
  const chosen =
    choices.kind !== "knowledge" ||
    allChosen(resource.collections, collections);
  const submit = () => {
    const target = targetOf(resource, choices, picked, collections);
    if (target === undefined) {
      return;
    }
    void decide(
      async (session) =>
        await session.resourceBindings.approve({
          app,
          alias,
          target,
          reviewed: { version },
        })
    );
  };
  const named = (permission: string) => t`Permission ${permission}`;
  return (
    <Form
      aria-label={t`Bind ${alias}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {choices.kind === "model" ? (
        <Choice
          items={choices.models.map((model) => ({
            value: model,
            label: model,
          }))}
          label={t`Model`}
          onChange={setPicked}
          value={picked}
        />
      ) : null}
      {choices.kind === "connector" ? (
        <Choice
          items={choices.permissions.map(({ permissionId, connectionId }) => ({
            value: permissionId,
            label:
              connections.find(({ id }) => id === connectionId)?.accountName ??
              t`Connection ${connectionId}`,
          }))}
          label={t`Connection`}
          onChange={setPicked}
          value={picked}
        />
      ) : null}
      {choices.kind === "grasp" ? (
        <Choice
          items={permissionItems(choices.permissions, named)}
          label={t`Permission for the platform's statistics`}
          onChange={setPicked}
          value={picked}
        />
      ) : null}
      {choices.kind === "guests" ? (
        <Choice
          items={permissionItems(choices.permissions, named)}
          label={t`Permission to invite guests`}
          onChange={setPicked}
          value={picked}
        />
      ) : null}
      {choices.kind === "knowledge"
        ? resource.collections.map((collection) => {
            const permission = collections[collection] ?? "";
            return (
              <Choice
                items={choices.permissions.map(({ permissionId, name }) => ({
                  value: permissionId,
                  label: name ?? permissionId,
                }))}
                key={collection}
                label={t`Collection for ${collection}`}
                onChange={(next) => {
                  setCollections({ ...collections, [collection]: next });
                }}
                placeholder={t`Choose a collection`}
                value={permission === "" ? null : permission}
              />
            );
          })
        : null}
      {choices.truncated ? (
        <Text size="sm" tone="muted">
          {t`Not every choice could be checked: some may be missing from the list.`}
        </Text>
      ) : null}
      <div>
        <Button disabled={busy || !chosen} size="sm" type="submit">
          {binding === null
            ? t`Bind ${alias}`
            : t`Replace the binding of ${alias}`}
        </Button>
      </div>
    </Form>
  );
};

/** Revoking `binding` of `alias`, once confirmed, as disconnecting is. */
const Revoke = ({
  alias,
  binding,
  busy,
  decide,
}: {
  alias: string;
  binding: ResourceBinding;
  busy: boolean;
  decide: Decide;
}) => {
  const { t } = useLingui();
  return (
    <AlertDialog>
      <AlertDialogTrigger
        aria-label={t`Revoke the binding of ${alias}`}
        disabled={busy}
        size="sm"
      >
        {t`Revoke`}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Revoke the binding of ${alias}?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`The App's next request through it is refused, and actions waiting on it are dropped. Bind it again to use it again.`}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            onClick={() => {
              void decide(
                async (session) =>
                  await session.resourceBindings.revoke(binding.id)
              );
            }}
            variant="danger"
          >
            {t`Revoke`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** What `resource` declares, and what it is bound to, as facts. */
const useFacts = () => {
  const { t } = useLingui();
  const boundTo = useBoundTo();
  return (resource: DeclaredResource): KeyValueItem[] => {
    const { contract, actions, operations, collections, binding } = resource;
    const tokens = resource.maxOutputTokens;
    const facts: (KeyValueItem | null)[] = [
      contract === null
        ? null
        : { key: t`Contract`, value: contract, mono: true },
      actions.length === 0
        ? null
        : { key: t`Actions`, value: formatList(actions) },
      operations.length === 0
        ? null
        : { key: t`Operations`, value: formatList(operations) },
      collections.length === 0
        ? null
        : { key: t`Collections`, value: formatList(collections) },
      tokens === null
        ? null
        : { key: t`Output`, value: t`At most ${tokens} tokens an answer` },
      binding === null
        ? null
        : {
            key: t`Bound to`,
            value: boundTo(binding),
            mono: binding.target.kind === "model",
          },
    ];
    return facts.filter((fact) => fact !== null);
  };
};

/** One declared resource: what it is, how it is bound, and for admins the controls. */
const ResourcePart = ({
  app,
  version,
  resource,
  connections,
  busy,
  decide,
}: {
  app: string;
  version: number;
  resource: DeclaredResource;
  connections: ListedConnection[];
  busy: boolean;
  decide: Decide;
}) => {
  const { i18n } = useLingui();
  const facts = useFacts();
  const { alias, kind, state, binding, choices } = resource;
  const reason = stateReasons[state];
  return (
    <section {...stylex.props(styles.resource)}>
      <SectionHeader
        actions={
          binding === null || choices === null ? undefined : (
            <Revoke
              alias={alias}
              binding={binding}
              busy={busy}
              decide={decide}
            />
          )
        }
        aside={
          <span {...stylex.props(styles.badges)}>
            <Badge>{i18n._(kindLabels[kind])}</Badge>
            <Badge tone={state === "served" ? "success" : "attention"}>
              {i18n._(stateLabels[state])}
            </Badge>
          </span>
        }
        headingLevel={4}
        size="sm"
        title={alias}
      />
      <KeyValueList items={facts(resource)} variant="inline" />
      {reason === undefined ? null : (
        <Alert live="off" tone="attention">
          {i18n._(reason)}
        </Alert>
      )}
      {choices === null ? null : (
        <BindForm
          app={app}
          busy={busy}
          choices={choices}
          connections={connections}
          decide={decide}
          resource={resource}
          version={version}
        />
      )}
    </section>
  );
};

/** Bindings of aliases the current version no longer declares. */
const Undeclared = ({
  bindings,
  decides,
  busy,
  decide,
}: {
  bindings: ResourceBinding[];
  decides: boolean;
  busy: boolean;
  decide: Decide;
}) => {
  const { t, i18n } = useLingui();
  return (
    <SectionCard
      density="compact"
      flush
      headingLevel={3}
      info={t`The current version doesn't declare these, so they serve nothing until a version declares them again.`}
      title={t`No longer declared`}
    >
      <Table aria-label={t`No longer declared`} density="compact">
        <TableHeader>
          <TableRow>
            <TableHead>{t`Resource`}</TableHead>
            <TableHead>{t`Kind`}</TableHead>
            <TableHead aria-label={t`Actions`} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {bindings.map((binding) => (
            <TableRow key={binding.id}>
              <TableCell lead>{binding.alias}</TableCell>
              <TableCell>{i18n._(kindLabels[binding.kind])}</TableCell>
              <TableCell align="end">
                {decides ? (
                  <Revoke
                    alias={binding.alias}
                    binding={binding}
                    busy={busy}
                    decide={decide}
                  />
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
};

/**
 * The App's declared resources and their bindings; with the controls
 * when the viewer `decides` them (an admin of the organization).
 */
export const ResourceBindings = ({
  page,
  decides,
}: {
  page: ResourcesPage;
  decides: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { review, connections } = page;
  const { app, version, resources, undeclared } = review;
  const decide: Decide = async (change) => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => await change(session),
        async () => {
          // `sync` waits for the loader, so the controls stay off until
          // what they act on is back.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <>
      <SectionCard
        density="compact"
        headingLevel={3}
        info={
          decides
            ? t`The App's actions reach a model, an integration or knowledge only through a binding an admin approves here. Declaring one grants nothing, and revoking a binding stops the next request through it.`
            : t`The App's actions reach a model, an integration or knowledge only through a binding an admin of your organization approves.`
        }
        title={t`Resources`}
      >
        <div {...stylex.props(styles.body)}>
          {version === null || resources.length === 0 ? (
            <Text size="sm" tone="muted">
              {t`The App's current version declares no resource for its actions.`}
            </Text>
          ) : (
            // One part each, with a line between them.
            resources.flatMap((resource, index) => [
              index === 0 ? null : (
                <Separator decorative key={`line-${resource.alias}`} />
              ),
              <ResourcePart
                app={app}
                busy={busy}
                connections={connections}
                decide={decide}
                // Another version, declaration, binding or set of offers
                // starts its forms afresh, on the newest choice.
                key={formKey(app, version, resource)}
                resource={resource}
                version={version}
              />,
            ])
          )}
          {failure === undefined ? null : (
            <Alert tone="danger">{failure}</Alert>
          )}
        </div>
      </SectionCard>
      {undeclared.length === 0 ? null : (
        <Undeclared
          bindings={undeclared}
          busy={busy}
          decide={decide}
          decides={decides}
        />
      )}
    </>
  );
};
