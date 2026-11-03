// @vitest-environment happy-dom
import { v } from "@grasp-os/sdk";
import type { FilesReference, InferInput } from "@grasp-os/sdk";
import { useForm } from "@grasp-os/sdk/react";
import {
  CheckboxField,
  DateField,
  DateTimeField,
  FileField,
  Form,
  MultiSelectField,
  NumberField,
  RelationField,
  RichTextField,
  SelectField,
  SubmitButton,
  SwitchField,
  TextField,
} from "@grasp-os/ui/form";
import { act } from "react";
import { describe, expect, it } from "vite-plus/test";

import {
  click,
  find,
  leave,
  named,
  reference,
  rendered,
  settle,
  testHost,
  typeInto,
  uploadedFileId,
  valueOf,
} from "./test-host.tsx";

// The form fields an App screen binds to a form `useForm` made, one for
// every kind of value its schema can declare, against a real session
// client: each says what the schema refuses (a value it needs, a bound,
// a whole number), only once the person left it or tried to submit, and
// hands the form the value the schema takes (an enum's value, a number, a
// day as the moment it starts, a record's ID, a file's reference,
// formatted text as Markdown).

const task = v.object({
  title: v.string().trim().min(1),
  status: v.enum(["open", "closed"]),
  labels: v.array(v.enum(["red", "green", "blue"])).min(1),
  estimate: v.number().integer().min(1).max(10),
  due: v.timestamp(),
  remind: v.timestamp().optional(),
  urgent: v.boolean(),
  notify: v.boolean(),
  owner: v.id("people"),
  notes: v.string().min(1),
  brief: v.file(),
});

type Task = InferInput<typeof task>;

const searchPeople = reference(
  "query",
  "people.search",
  v.object({ search: v.string() }),
  v.array(v.object({ _id: v.id("people"), name: v.string() }))
);

const briefs: FilesReference<"briefs", readonly ["upload"]> = {
  kind: "files",
  alias: "briefs",
  operations: ["upload"],
};

const grace = "01890000-0000-7000-8000-000000000002";
const directory = [
  { _id: "01890000-0000-7000-8000-000000000001", name: "Ada" },
  { _id: grace, name: "Grace" },
];

/** A new task, nothing filled in yet: what the schema still refuses. */
const blank: Partial<Task> = {
  title: "",
  labels: [],
  urgent: false,
  notify: false,
  notes: "",
};

const TaskForm = ({ saved }: { saved: unknown[] }) => {
  const form = useForm(task, {
    // SAFETY: a form starts with what the person hasn't filled in yet,
    // which the schema refuses until they do; that is what is tested.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    defaultValues: blank as Task,
    onSubmit: (values) => {
      saved.push(values);
    },
  });
  return (
    <Form form={form}>
      <TextField form={form} label="Title" name="title" />
      <SelectField
        form={form}
        label="Status"
        name="status"
        options={{ open: "Open", closed: "Closed" }}
      />
      <MultiSelectField
        form={form}
        label="Labels"
        name="labels"
        options={{ red: "Red", green: "Green", blue: "Blue" }}
      />
      <NumberField form={form} label="Estimate" name="estimate" />
      <DateField form={form} label="Due" name="due" />
      <DateTimeField form={form} label="Remind me" name="remind" />
      <CheckboxField form={form} label="Urgent" name="urgent" />
      <SwitchField form={form} label="Notify the team" name="notify" />
      <RelationField
        args={(search) => ({ search })}
        form={form}
        label="Owner"
        name="owner"
        optionLabel={(person) => person.name}
        query={searchPeople}
      />
      <RichTextField form={form} label="Notes" name="notes" />
      <FileField form={form} label="Brief" name="brief" resource={briefs} />
      <SubmitButton form={form}>Save task</SubmitButton>
    </Form>
  );
};

/** What the field labelled `label` says is wrong with it; "" for nothing. */
const errorOf = (label: string): string => {
  const heading = [...document.querySelectorAll("label, legend")].find(
    (element) => element.textContent?.trim() === label
  );
  const field = heading?.closest(
    '[data-slot="field"], [data-slot="field-set"]'
  );
  if (field === null || field === undefined) {
    throw new Error(`No field labelled ${label}.`);
  }
  return field.querySelector('[data-slot="field-error"]')?.textContent ?? "";
};

/** The control labelled `label`. */
const control = (label: string): HTMLElement => {
  const element = [...document.querySelectorAll("label")].find(
    (each) => each.textContent?.trim() === label
  );
  const id = element?.getAttribute("for");
  const found =
    id === null || id === undefined
      ? null
      : document.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (found === null) {
    throw new Error(`No control labelled ${label}.`);
  }
  return found;
};

const hostOf = () =>
  testHost((sent) => ({
    value: directory.filter(({ name }) =>
      name.toLowerCase().includes(String(sent.input.search).toLowerCase())
    ),
  }));

describe("the form fields", () => {
  it("say what the schema refuses once the person tries to submit, and not before", async () => {
    const saved: unknown[] = [];
    const { client } = hostOf();
    await rendered(client, <TaskForm saved={saved} />);
    expect(document.querySelectorAll('[data-slot="field-error"]')).toHaveLength(
      0
    );
    await click(find("button", "Save task"));
    expect({
      title: errorOf("Title"),
      status: errorOf("Status"),
      labels: errorOf("Labels"),
      estimate: errorOf("Estimate"),
      due: errorOf("Due"),
      remind: errorOf("Remind me"),
      owner: errorOf("Owner"),
      notes: errorOf("Notes"),
      brief: errorOf("Brief"),
    }).toStrictEqual({
      title: "The value is too short.",
      status: "A value is required.",
      labels: "The value is too short.",
      estimate: "A value is required.",
      due: "A value is required.",
      // Optional: nothing to say.
      remind: "",
      owner: "A value is required.",
      notes: "The value is too short.",
      brief: "A value is required.",
    });
    expect(saved).toStrictEqual([]);
    // Each control says so, for assistive technology.
    expect(control("Title").getAttribute("aria-invalid")).toBe("true");
    expect(control("Title").getAttribute("aria-required")).toBe("true");
  });

  it("check a number's bounds and that it is whole, from the schema", async () => {
    const { client } = hostOf();
    await rendered(client, <TaskForm saved={[]} />);
    const estimate = valueOf(control("Estimate"));
    expect({
      min: estimate.getAttribute("min"),
      max: estimate.getAttribute("max"),
      step: estimate.getAttribute("step"),
    }).toStrictEqual({
      min: "1",
      max: "10",
      step: "1",
    });
    await typeInto(estimate, "11");
    // Not while the person is still typing in it: once they leave it.
    expect(errorOf("Estimate")).toBe("");
    await leave(estimate);
    expect(errorOf("Estimate")).toBe("The number is too large.");
    await typeInto(estimate, "2.5");
    await leave(estimate);
    expect(errorOf("Estimate")).toBe("The number must be a whole number.");
    await typeInto(estimate, "3");
    await leave(estimate);
    expect(errorOf("Estimate")).toBe("");
  });

  it("hand the form each value as the schema takes it", async () => {
    const saved: unknown[] = [];
    const { client, reads, uploads } = hostOf();
    await rendered(client, <TaskForm saved={saved} />);

    await typeInto(control("Title"), " Launch ");
    await typeInto(control("Status"), "closed");
    await click(control("Blue"));
    await click(control("Red"));
    await typeInto(control("Estimate"), "3");
    await typeInto(control("Due"), "2026-11-03");
    await typeInto(control("Remind me"), "2026-11-02T09:30");
    await click(control("Urgent"));
    await click(control("Notify the team"));

    // The owner: searched for as typed, once typing settles, and picked.
    const owner = valueOf(control("Owner"));
    await typeInto(owner, "gra");
    await settle(300);
    expect(reads.at(-1)).toMatchObject({
      contractId: "people.search",
      input: { search: "gra" },
    });
    await click(find('[role="option"]', "Grace"));
    expect(owner.value).toBe("Grace");

    // Notes: typed, then made bold from the toolbar, as Markdown.
    const notes = control("Notes");
    if (!(notes instanceof HTMLTextAreaElement)) {
      throw new TypeError("Notes aren't a text area.");
    }
    await typeInto(notes, "Ship it");
    notes.setSelectionRange(0, "Ship it".length);
    await click(named("Bold"));

    // The brief: uploaded through the App's files resource.
    const brief = control("Brief");
    await act(async () => {
      Object.defineProperty(brief, "files", {
        value: [new File(["# Brief"], "brief.md", { type: "text/markdown" })],
      });
      brief.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await settle();
    expect(uploads).toStrictEqual([{ resource: "briefs", name: "brief.md" }]);
    expect(document.body.textContent).toContain("brief.md");

    await click(find("button", "Save task"));
    await settle();
    expect(saved).toStrictEqual([
      {
        title: "Launch",
        status: "closed",
        // In the schema's order, whatever order they were picked in.
        labels: ["red", "blue"],
        estimate: 3,
        // The day, as the moment it starts in UTC.
        due: Date.UTC(2026, 10, 3),
        // The moment, in the person's own time zone.
        remind: new Date(2026, 10, 2, 9, 30).getTime(),
        urgent: true,
        notify: true,
        owner: grace,
        notes: "**Ship it**",
        brief: { id: uploadedFileId },
      },
    ]);
  });

  it("clear a choice the person takes back, which the schema then needs again", async () => {
    const { client } = hostOf();
    await rendered(client, <TaskForm saved={[]} />);
    const status = control("Status");
    await typeInto(status, "open");
    await typeInto(status, "");
    await click(find("button", "Save task"));
    expect(errorOf("Status")).toBe("A value is required.");
  });
});
