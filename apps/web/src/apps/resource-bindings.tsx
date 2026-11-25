import type { ListedConnection } from "@grasp-os/shared/connect";
import type {
  BindingChoices,
  BindingState,
  DeclaredResource,
  ResourceBinding,
  ResourceBindingsReview,
} from "@grasp-os/shared/resource-bindings";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Separator } from "@grasp-os/ui/components/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { formatList } from "../format.ts";
import { WithInfo } from "../frame/info-tip.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { firstChoice, formKey, noChoice, targetOf } from "./binding-form.ts";

// What an App's actions reach through its declared resources (core's
// resource-bindings.ts): the models, integrations and the Brain
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
  connector: msg`Connector`,
  brain: msg`Brain`,
  grasp: msg`The platform's statistics`,
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
    unchecked: msg`The App has too many connectors to check them all on this page, so this binding wasn't checked. Its next request is checked as always.`,
  };

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: space[4] },
  resource: { display: "flex", flexDirection: "column", gap: space[3] },
  badges: { display: "flex", flexWrap: "wrap", gap: space[1] },
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
    // The platform's statistics or the Brain: one of the App's
    // platform permissions.
    const { permissionId: permission } = target;
    return t`Permission ${permission}`;
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
      <Text size="sm" color="muted">
        {t`Not every choice could be checked, and none of those checked can serve it. Reload the page to check again.`}
      </Text>
    );
  }
  const reasons: Readonly<Record<DeclaredResource["kind"], string>> = {
    model: t`This deployment allows no model.`,
    connector: t`None of the App's connector permissions serves ${contract} with every action it declares. Grant one first.`,
    brain: t`The App has no permission to read the Brain. Grant one first.`,
    grasp: t`The App has no permission to read the platform's statistics. Grant one first.`,
  };
  return (
    <Text size="sm" color="muted">
      {reasons[resource.kind]}
    </Text>
  );
};

/** The permissions a choice of the platform's offers, as a select's items. */
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
  if (noChoice(choices)) {
    return (
      <NothingToChoose resource={resource} truncated={choices.truncated} />
    );
  }
  const submit = () => {
    const target = targetOf(choices, picked);
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
      {choices.kind === "brain" ? (
        <Choice
          items={permissionItems(choices.permissions, named)}
          label={t`Permission to read the Brain`}
          onChange={setPicked}
          value={picked}
        />
      ) : null}
      {choices.truncated ? (
        <Text size="sm" color="muted">
          {t`Not every choice could be checked: some may be missing from the list.`}
        </Text>
      ) : null}
      <div>
        <Button disabled={busy} size="sm" type="submit" variant="outline">
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
      <AlertDialogTrigger asChild>
        <Button
          aria-label={t`Revoke the binding of ${alias}`}
          disabled={busy}
          size="sm"
          variant="outline"
        >
          {t`Revoke`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Revoke the binding of ${alias}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`The App's next request through it is refused, and actions waiting on it are dropped. Bind it again to use it again.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            onClick={() => {
              void decide(
                async (session) =>
                  await session.resourceBindings.revoke(binding.id)
              );
            }}
            variant="destructive"
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
    const { contract, actions, operations, binding } = resource;
    const tokens = resource.maxOutputTokens;
    const facts: (KeyValueItem | null)[] = [
      contract === null
        ? null
        : { id: "contract", label: t`Contract`, value: contract, mono: true },
      actions.length === 0
        ? null
        : { id: "actions", label: t`Actions`, value: formatList(actions) },
      operations.length === 0
        ? null
        : {
            id: "operations",
            label: t`Operations`,
            value: formatList(operations),
          },
      tokens === null
        ? null
        : {
            id: "output",
            label: t`Output`,
            value: t`At most ${tokens} tokens an answer`,
          },
      binding === null
        ? null
        : {
            id: "bound",
            label: t`Bound to`,
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
  const { t, i18n } = useLingui();
  const facts = useFacts();
  const { alias, kind, state, binding, choices } = resource;
  const reason = stateReasons[state];
  // Named by its heading, so a screen reader lists each resource by its alias.
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} {...stylex.props(styles.resource)}>
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
        badge={
          <span {...stylex.props(styles.badges)}>
            <Badge>{i18n._(kindLabels[kind])}</Badge>
            <Badge variant={state === "served" ? "success" : "warning"}>
              {i18n._(stateLabels[state])}
            </Badge>
          </span>
        }
        headingLevel={4}
        id={headingId}
        size="sm"
        title={alias}
      />
      <KeyValueList items={facts(resource)} orientation="horizontal" />
      {kind === "brain" &&
      resource.operations.some(
        (operation) => operation === "remember" || operation === "forget"
      ) ? (
        // What approving the App's writes means, in plain words (core's
        // brain-app-writes.ts): who reads what it saves, and through what.
        <Text size="sm" color="muted">
          {t`This App can save memories in the Brain in its own name, which everyone who uses the App reads through it, and only through it, and it can take its own back.`}
        </Text>
      ) : null}
      {reason === undefined ? null : (
        <Alert live="off" variant="warning">
          <AlertDescription>{i18n._(reason)}</AlertDescription>
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
    <Card size="sm" asChild>
      <section aria-label={t`No longer declared`}>
        <CardHeader>
          <WithInfo
            of="title"
            info={t`The current version doesn't declare these, so they serve nothing until a version declares them again.`}
          >
            <CardTitle level={3}>{t`No longer declared`}</CardTitle>
          </WithInfo>
        </CardHeader>
        <CardContent flush>
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
                  <TableCell rowHeader>{binding.alias}</TableCell>
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
        </CardContent>
      </section>
    </Card>
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
      <Card size="sm" asChild>
        <section aria-label={t`Resources`}>
          <CardHeader>
            <WithInfo
              of="title"
              info={
                decides
                  ? t`The App's actions reach a model, a connector or knowledge only through a binding an admin approves here. Declaring one grants nothing, and revoking a binding stops the next request through it.`
                  : t`The App's actions reach a model, a connector or knowledge only through a binding an admin of your organization approves.`
              }
            >
              <CardTitle level={3}>{t`Resources`}</CardTitle>
            </WithInfo>
          </CardHeader>
          <CardContent>
            <div {...stylex.props(styles.body)}>
              {version === null || resources.length === 0 ? (
                <Text size="sm" color="muted">
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
                <Alert variant="destructive">
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              )}
            </div>
          </CardContent>
        </section>
      </Card>
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
