/**
 * The form that changes how models are reached: a client's transport on
 * its Setup, or a platform default on Platform's AI page. The way to
 * reach them and the fields it needs, failing over to a second way (off
 * unless staff turn it on), and going back to the default. Keys are named,
 * never given: their values are in Secrets Store (`MODEL_PROVIDER_KEYS`).
 */
import type { ModelTransport } from "@grasp-os/shared/model-transport";
import { modelTransportKinds } from "@grasp-os/shared/model-transport";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useState } from "react";

import { Failure } from "./setup-parts.tsx";
import {
  directProviders,
  fieldValuesOf,
  kindWords,
  transportOfForm,
} from "./transport-words.ts";
import type { KindChoice } from "./transport-words.ts";

/** What the form saves: a transport and its failover, or null for the default. */
export interface TransportChoice {
  primary: unknown;
  failover: unknown[];
  /** Whether staff keep its AI in the EU, where its policy lets it run anywhere. */
  euOnly: boolean;
}

/** The kind `value` names, from the select. */
const kindOf = (value: string): KindChoice =>
  modelTransportKinds.find((kind) => kind === value) ?? "default";

/** The fields one transport needs, by its kind, named `<prefix>-…`. */
const TransportFields = ({
  prefix,
  transport,
  allowDefault,
  defaultWords,
  kind,
  onKind,
  attested,
  onAttested,
}: {
  prefix: string;
  transport: ModelTransport | null;
  allowDefault: boolean;
  defaultWords: string;
  kind: KindChoice;
  onKind: (kind: KindChoice) => void;
  attested: boolean;
  onAttested: (attested: boolean) => void;
}) => {
  const values = fieldValuesOf(transport);
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`${prefix}-kind`}>
          How it reaches models
        </FieldLabel>
        <NativeSelect
          id={`${prefix}-kind`}
          onChange={(event) => {
            onKind(kindOf(event.target.value));
          }}
          value={kind}
        >
          {allowDefault ? (
            <NativeSelectOption value="default">
              {defaultWords}
            </NativeSelectOption>
          ) : null}
          {modelTransportKinds.map((each) => (
            <NativeSelectOption key={each} value={each}>
              {kindWords[each]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {kind === "openrouter" ? (
        <Field>
          <FieldLabel htmlFor={`${prefix}-openrouter-key`}>Key name</FieldLabel>
          <Input
            defaultValue={values.openrouterKey}
            id={`${prefix}-openrouter-key`}
            name={`${prefix}-openrouter-key`}
          />
          <FieldDescription>
            Its entry in MODEL_PROVIDER_KEYS in Secrets Store.
          </FieldDescription>
        </Field>
      ) : null}
      {kind === "direct" ? (
        <FieldSet>
          <FieldLegend variant="label">
            Each provider&apos;s key name
          </FieldLegend>
          <FieldDescription>
            Its entry in MODEL_PROVIDER_KEYS in Secrets Store. Leave a provider
            empty to not use it.
          </FieldDescription>
          {directProviders.map(({ id, words }) => (
            <Field key={id}>
              <FieldLabel htmlFor={`${prefix}-direct-${id}`}>
                {words}
              </FieldLabel>
              <Input
                defaultValue={values.directKeys[id]}
                id={`${prefix}-direct-${id}`}
                name={`${prefix}-direct-${id}`}
              />
            </Field>
          ))}
        </FieldSet>
      ) : null}
      {kind === "openai-compatible" ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
            <Input
              defaultValue={values.name}
              id={`${prefix}-name`}
              name={`${prefix}-name`}
              placeholder="acme-azure"
              required
            />
            <FieldDescription>
              Lowercase letters, digits and dashes: how Setup, the ledger and
              the audit log name it.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-base-url`}>Base URL</FieldLabel>
            <Input
              defaultValue={values.baseUrl}
              id={`${prefix}-base-url`}
              name={`${prefix}-base-url`}
              placeholder="https://"
              required
              type="url"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-key`}>Key name</FieldLabel>
            <Input
              defaultValue={values.key}
              id={`${prefix}-key`}
              name={`${prefix}-key`}
            />
            <FieldDescription>
              Its entry in MODEL_PROVIDER_KEYS in Secrets Store; empty for an
              endpoint that takes none.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-models`}>Models</FieldLabel>
            <Textarea
              defaultValue={values.models}
              id={`${prefix}-models`}
              name={`${prefix}-models`}
              placeholder="openai/gpt-5 = my-gpt-5-deployment"
              required
            />
            <FieldDescription>
              One a line: the model as Grasp names it, then its name at the
              endpoint.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              checked={attested}
              id={`${prefix}-attested`}
              onCheckedChange={onAttested}
            />
            <FieldLabel htmlFor={`${prefix}-attested`}>
              I attest this endpoint processes in the EU
            </FieldLabel>
          </Field>
          {attested ? (
            <Field>
              <FieldLabel htmlFor={`${prefix}-basis`}>On what basis</FieldLabel>
              <Input
                defaultValue={values.basis}
                id={`${prefix}-basis`}
                name={`${prefix}-basis`}
                placeholder="https://"
                required
                type="url"
              />
              <FieldDescription>
                The documentation or contract that says so. Recorded as yours,
                with the time you save it.
              </FieldDescription>
            </Field>
          ) : null}
        </>
      ) : null}
    </FieldGroup>
  );
};

/** The attestation `transport` carries, if it's a custom endpoint with one. */
const attestationOf = (transport: ModelTransport | null): unknown =>
  transport?.kind === "openai-compatible" ? transport.euAttestation : undefined;

/**
 * Changing how models are reached, from `current` (null while the
 * default holds): `onSave` gets the transport and failover, or null to go
 * back to the default, and answers why it failed, if it did.
 */
export const TransportForm = ({
  id,
  current,
  defaultWords,
  offerEuOnly,
  euOnly,
  busy,
  failure,
  onSave,
}: {
  /** Prefixes the fields' ids, unique on the page. */
  id: string;
  current: { primary: ModelTransport; failover: ModelTransport[] } | null;
  defaultWords: string;
  /** Whether to offer keeping AI in the EU: for a policy that lets it run anywhere. */
  offerEuOnly: boolean;
  euOnly: boolean;
  busy: boolean;
  failure: string | null;
  onSave: (choice: TransportChoice | null) => void;
}) => {
  const primary = current?.primary ?? null;
  const [firstFailover = null] = current?.failover ?? [];
  const [kind, setKind] = useState<KindChoice>(primary?.kind ?? "default");
  const [attested, setAttested] = useState(
    attestationOf(primary) !== undefined
  );
  const [failingOver, setFailingOver] = useState(firstFailover !== null);
  const [failoverKind, setFailoverKind] = useState<KindChoice>(
    firstFailover?.kind ?? "cloudflare-ai-gateway"
  );
  const [failoverAttested, setFailoverAttested] = useState(
    attestationOf(firstFailover) !== undefined
  );
  const [keepInEu, setKeepInEu] = useState(euOnly);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const chosen = transportOfForm(form, `${id}-primary`, kind, {
          attested,
          kept: attestationOf(primary),
        });
        if (chosen === null) {
          onSave(null);
          return;
        }
        const failover =
          failingOver && failoverKind !== "default"
            ? [
                transportOfForm(form, `${id}-failover`, failoverKind, {
                  attested: failoverAttested,
                  kept: attestationOf(firstFailover),
                }),
              ]
            : [];
        onSave({ primary: chosen, failover, euOnly: keepInEu });
      }}
    >
      <TransportFields
        allowDefault
        attested={attested}
        defaultWords={defaultWords}
        kind={kind}
        onAttested={setAttested}
        onKind={setKind}
        prefix={`${id}-primary`}
        transport={primary}
      />
      {kind === "default" ? null : (
        <>
          <Field orientation="horizontal">
            <Checkbox
              checked={failingOver}
              id={`${id}-failing-over`}
              onCheckedChange={setFailingOver}
            />
            <FieldLabel htmlFor={`${id}-failing-over`}>
              Fail over to another way while this one fails
            </FieldLabel>
          </Field>
          {failingOver ? (
            <TransportFields
              allowDefault={false}
              attested={failoverAttested}
              defaultWords={defaultWords}
              kind={failoverKind}
              onAttested={setFailoverAttested}
              onKind={setFailoverKind}
              prefix={`${id}-failover`}
              transport={firstFailover}
            />
          ) : null}
          {offerEuOnly ? (
            <Field orientation="horizontal">
              <Checkbox
                checked={keepInEu}
                id={`${id}-eu-only`}
                onCheckedChange={setKeepInEu}
              />
              <FieldLabel htmlFor={`${id}-eu-only`}>
                Keep its AI in the EU
              </FieldLabel>
            </Field>
          ) : null}
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          Save
        </Button>
        <Failure failure={failure} />
      </div>
    </form>
  );
};
