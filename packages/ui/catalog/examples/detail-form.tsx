// A record's detail form: labelled fields in groups, a description and an
// error where they help, and the actions at the end. Every control has a
// label; errors are tied to their field.
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Inline } from "@grasp-os/ui/components/inline";
import { Input } from "@grasp-os/ui/components/input";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Stack } from "@grasp-os/ui/components/stack";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";

const terms = [
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
];

export const DetailFormExample = () => (
  <Stack gap="lg">
    <PageHeader>
      <PageHeaderContent>
        <PageHeaderTitle>Acme Corp</PageHeaderTitle>
        <PageHeaderDescription>
          Customer details and billing.
        </PageHeaderDescription>
      </PageHeaderContent>
    </PageHeader>
    <form>
      <FieldGroup>
        <FieldSet>
          <FieldLegend>Contact</FieldLegend>
          <Field>
            <FieldLabel htmlFor="customer-name">Name</FieldLabel>
            <Input id="customer-name" defaultValue="Acme Corp" />
          </Field>
          <Field data-invalid>
            <FieldLabel htmlFor="customer-email">Billing email</FieldLabel>
            <Input
              id="customer-email"
              type="email"
              defaultValue="billing@"
              aria-invalid
              aria-describedby="customer-email-error"
            />
            <FieldError id="customer-email-error">
              Enter an email address, like name@example.com.
            </FieldError>
          </Field>
        </FieldSet>
        <FieldSet>
          <FieldLegend>Billing</FieldLegend>
          <Field>
            <FieldLabel htmlFor="customer-terms">Payment terms</FieldLabel>
            <Select items={terms} defaultValue="30">
              <SelectTrigger id="customer-terms">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {terms.map((term) => (
                  <SelectItem key={term.value} value={term.value}>
                    {term.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <Switch id="customer-reminders" defaultChecked />
            <FieldLabel htmlFor="customer-reminders">
              Send payment reminders
            </FieldLabel>
          </Field>
          <Field>
            <FieldLabel htmlFor="customer-notes">Notes</FieldLabel>
            <Textarea
              id="customer-notes"
              aria-describedby="customer-notes-hint"
            />
            <FieldDescription id="customer-notes-hint">
              Only your team sees these.
            </FieldDescription>
          </Field>
        </FieldSet>
        <Inline justify="end">
          <Button variant="outline" type="button">
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </Inline>
      </FieldGroup>
    </form>
  </Stack>
);
