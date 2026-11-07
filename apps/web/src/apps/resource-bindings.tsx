import type { ListedConnection } from "@grasp-os/shared/connect";
import type {
  BindingChoices,
  BindingState,
  DeclaredResource,
  ResourceBinding,
  ResourceBindingsReview,
} from "@grasp-os/shared/resource-bindings";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  allChosen,
  firstChoice,
  formKey,
  noChoice,
  targetOf,
} from "./binding-form.ts";

// What an App's actions reach through its declared resources (core's
// resource-bindings.ts): the models, integrations, knowledge and templates
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

/** One term of a definition list and what it says. */
const Term = ({ term, children }: { term: ReactNode; children: ReactNode }) => (
  <div className="flex flex-wrap gap-x-2">
    <dt className="text-muted-foreground">{term}</dt>
    <dd>{children}</dd>
  </div>
);

/** A change to what core holds, then the page read again. */
type Decide = (change: (session: Session) => Promise<unknown>) => Promise<void>;

/** What a resource's binding binds it to, named as far as the page can. */
const BoundTo = ({
  binding,
}: {
  binding: NonNullable<DeclaredResource["binding"]>;
}) => {
  const { target, label } = binding;
  if (target.kind === "model") {
    return <span className="font-mono">{target.model}</span>;
  }
  if (target.kind === "guests" || target.kind === "grasp") {
    const { permissionId: permission } = target;
    return <Trans>Permission {permission}</Trans>;
  }
  if (target.kind === "connector") {
    // Core names the bound connection for everyone who reads the review,
    // while they can see it; its permission otherwise.
    const { permissionId: permission } = target;
    if (label.connection === null) {
      return <Trans>Permission {permission}</Trans>;
    }
    const { provider } = label.connection;
    const account = label.connection.account ?? provider;
    return (
      <Trans>
        {account} on {provider}
      </Trans>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {Object.entries(target.collections).map(([collection, permission]) => {
        const name = label.collections[collection] ?? permission;
        return (
          <li key={collection}>
            <Trans>
              {collection}: {name}
            </Trans>
          </li>
        );
      })}
    </ul>
  );
};

/** One labelled native select. */
const Choice = ({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) => {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        value={value}
      >
        {children}
      </NativeSelect>
    </Field>
  );
};

/** Why nothing can be chosen for a resource yet, by its kind. */
const NothingToChoose = ({
  resource,
  truncated,
}: {
  resource: DeclaredResource;
  truncated: boolean;
}) => {
  const { contract } = resource;
  if (truncated) {
    // Some were never checked: that none is listed doesn't mean none exists.
    return (
      <p className="text-muted-foreground max-w-prose">
        <Trans>
          Not every choice could be checked, and none of those checked can serve
          it. Reload the page to check again.
        </Trans>
      </p>
    );
  }
  const reasons: Readonly<Record<DeclaredResource["kind"], ReactNode>> = {
    model: <Trans>This deployment allows no model.</Trans>,
    connector: (
      <Trans>
        None of the App&apos;s integration permissions serves {contract} with
        every action it declares. Grant one first.
      </Trans>
    ),
    knowledge: (
      <Trans>
        The App has no permission to read a collection. Grant one first.
      </Trans>
    ),
    grasp: (
      <Trans>
        The App has no permission to read the platform&apos;s statistics. Grant
        one first.
      </Trans>
    ),
    guests: (
      <Trans>
        The App has no permission to invite guests. Grant one first.
      </Trans>
    ),
  };
  return (
    <p className="text-muted-foreground max-w-prose">
      {reasons[resource.kind]}
    </p>
  );
};

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
  return (
    <form
      aria-label={t`Bind ${alias}`}
      className="flex flex-col items-start gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {choices.kind === "model" ? (
        <Choice label={t`Model`} onChange={setPicked} value={picked}>
          {choices.models.map((model) => (
            <NativeSelectOption key={model} value={model}>
              {model}
            </NativeSelectOption>
          ))}
        </Choice>
      ) : null}
      {choices.kind === "connector" ? (
        <Choice label={t`Connection`} onChange={setPicked} value={picked}>
          {choices.permissions.map(({ permissionId, connectionId }) => (
            <NativeSelectOption key={permissionId} value={permissionId}>
              {/* An option holds text only: the name, as text. */}
              {connections.find(({ id }) => id === connectionId)?.accountName ??
                t`Connection ${connectionId}`}
            </NativeSelectOption>
          ))}
        </Choice>
      ) : null}
      {choices.kind === "grasp" ? (
        <Choice
          label={t`Permission for the platform's statistics`}
          onChange={setPicked}
          value={picked}
        >
          {choices.permissions.map(({ permissionId: permission }) => (
            <NativeSelectOption key={permission} value={permission}>
              {t`Permission ${permission}`}
            </NativeSelectOption>
          ))}
        </Choice>
      ) : null}
      {choices.kind === "guests" ? (
        <Choice
          label={t`Permission to invite guests`}
          onChange={setPicked}
          value={picked}
        >
          {choices.permissions.map(({ permissionId: permission }) => (
            <NativeSelectOption key={permission} value={permission}>
              {t`Permission ${permission}`}
            </NativeSelectOption>
          ))}
        </Choice>
      ) : null}
      {choices.kind === "knowledge"
        ? resource.collections.map((collection) => (
            <Choice
              key={collection}
              label={t`Collection for ${collection}`}
              onChange={(permission) => {
                setCollections({ ...collections, [collection]: permission });
              }}
              value={collections[collection] ?? ""}
            >
              <NativeSelectOption value="">{t`Choose a collection`}</NativeSelectOption>
              {choices.permissions.map(({ permissionId, name }) => (
                <NativeSelectOption key={permissionId} value={permissionId}>
                  {name ?? permissionId}
                </NativeSelectOption>
              ))}
            </Choice>
          ))
        : null}
      {choices.truncated ? (
        <p className="text-muted-foreground max-w-prose">
          <Trans>
            Not every choice could be checked: some may be missing from the
            list.
          </Trans>
        </p>
      ) : null}
      <Button disabled={busy || !chosen} size="sm" type="submit">
        {binding === null ? (
          <Trans>Bind {alias}</Trans>
        ) : (
          <Trans>Replace the binding of {alias}</Trans>
        )}
      </Button>
    </form>
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
  const [confirming, setConfirming] = useState(false);
  return (
    <Dialog onOpenChange={setConfirming} open={confirming}>
      <DialogTrigger
        render={
          <Button
            aria-label={t`Revoke the binding of ${alias}`}
            disabled={busy}
            size="sm"
            variant="outline"
          />
        }
      >
        <Trans>Revoke</Trans>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Revoke the binding of {alias}?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              The App&apos;s next request through it is refused, and actions
              waiting on it are dropped. Bind it again to use it again.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter closeLabel={t`Close`} showCloseButton>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              void decide(
                async (session) =>
                  await session.resourceBindings.revoke(binding.id)
              );
            }}
            variant="destructive"
          >
            <Trans>Revoke</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** What `resource` declares, as a list of terms. */
const Declared = ({ resource }: { resource: DeclaredResource }) => {
  const { contract, actions, operations, collections, usedBy } = resource;
  const tokens = resource.maxOutputTokens;
  return (
    <dl className="flex flex-col gap-1">
      {contract === null ? null : (
        <Term term={<Trans>Contract</Trans>}>
          <span className="font-mono">{contract}</span>
        </Term>
      )}
      {actions.length === 0 ? null : (
        <Term term={<Trans>Actions</Trans>}>{formatList(actions)}</Term>
      )}
      {operations.length === 0 ? null : (
        <Term term={<Trans>Operations</Trans>}>{formatList(operations)}</Term>
      )}
      {collections.length === 0 ? null : (
        <Term term={<Trans>Collections</Trans>}>{formatList(collections)}</Term>
      )}
      {tokens === null ? null : (
        <Term term={<Trans>Output</Trans>}>
          <Trans>At most {tokens} tokens an answer</Trans>
        </Term>
      )}
      <Term term={<Trans>Used by</Trans>}>
        <span className="font-mono">{formatList(usedBy)}</span>
      </Term>
    </dl>
  );
};

/** One declared resource: what it is, how it is bound, and for admins the controls. */
const ResourceCard = ({
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
  const { alias, kind, state, binding, choices } = resource;
  const reason = stateReasons[state];
  const headingId = useId();
  return (
    <article
      aria-labelledby={headingId}
      className="bg-card flex flex-col gap-4 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono font-medium" id={headingId}>
          {alias}
        </h3>
        <Badge variant="outline">{i18n._(kindLabels[kind])}</Badge>
        <Badge variant={state === "served" ? "secondary" : "attention"}>
          {i18n._(stateLabels[state])}
        </Badge>
      </div>
      <Declared resource={resource} />
      {reason === undefined ? null : (
        <p className="text-muted-foreground max-w-prose">{i18n._(reason)}</p>
      )}
      {binding === null ? null : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">
              <Trans>Bound to</Trans>
            </span>
            <BoundTo binding={binding} />
          </div>
          {choices === null ? null : (
            <Revoke
              alias={alias}
              binding={binding}
              busy={busy}
              decide={decide}
            />
          )}
        </div>
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
    </article>
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
  const { i18n } = useLingui();
  return (
    <section
      aria-labelledby="app-undeclared-resources"
      className="flex flex-col gap-3"
    >
      <h3 className="text-sm font-medium" id="app-undeclared-resources">
        <Trans>No longer declared</Trans>
      </h3>
      <p className="text-muted-foreground max-w-prose">
        <Trans>
          The current version doesn&apos;t declare these, so they serve nothing
          until a version declares them again.
        </Trans>
      </p>
      <div className="bg-card overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">
                <Trans>Resource</Trans>
              </TableHead>
              <TableHead className="w-40" variant="card">
                <Trans>Kind</Trans>
              </TableHead>
              <TableHead className="w-40" variant="card" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {bindings.map((binding) => (
              <TableRow key={binding.id}>
                <TableCell variant="card">
                  <span className="font-mono">{binding.alias}</span>
                </TableCell>
                <TableCell variant="card">
                  {i18n._(kindLabels[binding.kind])}
                </TableCell>
                <TableCell className="text-right" variant="card">
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
      </div>
    </section>
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
    <section aria-labelledby="app-resources" className="flex flex-col gap-4">
      <h2 className="font-medium" id="app-resources">
        <Trans>Resources</Trans>
      </h2>
      <p className="text-muted-foreground max-w-prose">
        {decides ? (
          <Trans>
            The App&apos;s actions reach a model, an integration, knowledge or a
            template only through a binding an admin approves here. Declaring
            one grants nothing, and revoking a binding stops the next request
            through it.
          </Trans>
        ) : (
          <Trans>
            The App&apos;s actions reach a model, an integration, knowledge or a
            template only through a binding an admin of your organization
            approves.
          </Trans>
        )}
      </p>
      {version === null || resources.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>
            The App&apos;s current version declares no resource for its actions.
          </Trans>
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {resources.map((resource) => (
            <ResourceCard
              app={app}
              busy={busy}
              connections={connections}
              decide={decide}
              // Another version, declaration, binding or set of offers
              // starts its forms afresh, on the newest choice.
              key={formKey(app, version, resource)}
              resource={resource}
              version={version}
            />
          ))}
        </div>
      )}
      {undeclared.length === 0 ? null : (
        <Undeclared
          bindings={undeclared}
          busy={busy}
          decide={decide}
          decides={decides}
        />
      )}
      <ErrorText>{failure}</ErrorText>
    </section>
  );
};
