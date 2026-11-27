/**
 * A client's sign-in as a form asks for it, for adding an organization
 * and its Setup in the admin: the fields, and reading them back.
 */
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";

import { InvalidFieldError } from "../use-action.ts";
import { signInProblem } from "./sign-in-schema.ts";
import type { ClientSignInRecord } from "./sign-in-schema.ts";

/** The form's text field `name`, trimmed. */
export const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const listSeparator = /[\s,]+/u;

/** The form's list field `name`: its entries, split on commas and spaces. */
const listOf = (form: FormData, name: string): string[] =>
  textOf(form, name)
    .split(listSeparator)
    .filter((entry) => entry !== "");

/** The client's sign-in, as the form says it, or why it can't be one. */
export const signInOf = (form: FormData): ClientSignInRecord => {
  const entraTenantId = textOf(form, "entraTenantId");
  const googleHostedDomain = textOf(form, "googleHostedDomain");
  if (entraTenantId === "" && googleHostedDomain === "") {
    throw new InvalidFieldError(
      "Give the client's Entra tenant id, its Google Workspace domain, or both."
    );
  }
  const signIn = {
    domains: listOf(form, "domains"),
    admins: listOf(form, "admins"),
    ...(entraTenantId === "" ? {} : { entraTenantId }),
    ...(googleHostedDomain === "" ? {} : { googleHostedDomain }),
  };
  // The server's own check (a first admin who can sign in, among others),
  // said before anything is sent.
  const problem = signInProblem(signIn);
  if (problem !== null) {
    throw new InvalidFieldError(problem);
  }
  return signIn;
};

/**
 * The sign-in fields, filled with `current` when there is one, as the
 * admin's forms lay fields out: each Field wires its label, words and
 * control itself.
 */
export const SignInFields = ({
  current,
}: {
  current: ClientSignInRecord | null;
}) => (
  <>
    <Field>
      <FieldLabel>Entra tenant id</FieldLabel>
      <Input defaultValue={current?.entraTenantId} mono name="entraTenantId" />
      <FieldDescription>If its people sign in with Microsoft.</FieldDescription>
    </Field>
    <Field>
      <FieldLabel>Google Workspace domain</FieldLabel>
      <Input
        defaultValue={current?.googleHostedDomain}
        name="googleHostedDomain"
      />
      <FieldDescription>
        Its primary domain, if its people sign in with Google.
      </FieldDescription>
    </Field>
    <Field>
      <FieldLabel>Email domains</FieldLabel>
      <Input
        defaultValue={current?.domains.join(", ")}
        name="domains"
        required
      />
      <FieldDescription>
        The domains its people sign in with, exactly, separated by commas.
      </FieldDescription>
    </Field>
    <Field>
      <FieldLabel>First admins</FieldLabel>
      <Input defaultValue={current?.admins.join(", ")} name="admins" required />
      <FieldDescription>
        Emails that get the admin role when they first sign in, separated by
        commas: at least one, each in the email domains.
      </FieldDescription>
    </Field>
  </>
);
