/**
 * Where an organization's Grasp runs, as staff choose it on the create
 * page (src/hosting/organization.ts): Grasp Cloud, its data kept in the
 * EU unless unticked, or its own premises. Fixed once it is provisioned.
 */
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { useId } from "react";

import type { OrganizationHosting } from "./organization.ts";

/** The choice itself, controlled by `value`. */
export const HostingChoice = ({
  value,
  onChange,
}: {
  value: OrganizationHosting;
  onChange: (value: OrganizationHosting) => void;
}) => {
  const id = useId();
  const keepInEu = value.jurisdiction === "eu";
  return (
    <FieldSet>
      <FieldLegend variant="label">Hosting</FieldLegend>
      <RadioGroup
        name="hosting"
        onValueChange={(next) => {
          onChange({
            ...value,
            hosting: next === "on_prem" ? "on_prem" : "grasp_cloud",
          });
        }}
        value={value.hosting}
      >
        <Field orientation="horizontal">
          <RadioGroupItem id={`${id}-cloud`} value="grasp_cloud" />
          <FieldLabel htmlFor={`${id}-cloud`}>Grasp Cloud</FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem id={`${id}-on-prem`} value="on_prem" />
          <FieldLabel htmlFor={`${id}-on-prem`}>On-premises</FieldLabel>
        </Field>
      </RadioGroup>
      {value.hosting === "grasp_cloud" ? (
        <Field orientation="horizontal">
          <Checkbox
            checked={keepInEu}
            id={`${id}-eu`}
            name="keepInEu"
            onCheckedChange={(checked) => {
              onChange({ ...value, jurisdiction: checked ? "eu" : "none" });
            }}
          />
          <FieldContent>
            <FieldLabel htmlFor={`${id}-eu`}>Keep data in the EU</FieldLabel>
            <FieldDescription>
              {keepInEu
                ? "Its databases, files and Durable Objects are created in the EU. This can't change later."
                : "Data can be stored anywhere in Cloudflare's network. This can't change later."}
            </FieldDescription>
          </FieldContent>
        </Field>
      ) : (
        <FieldDescription>
          Grasp runs on the organization&apos;s own servers. On-prem setup
          arrives with GRA-1291.
        </FieldDescription>
      )}
    </FieldSet>
  );
};
