// The kit's form in a real Chromium, as an App page's frame runs it: the
// frame fires no submit event (frame-refusals.ts), so the form submits
// only on what the page itself does with the person's click or key.
import "./kit.css";
import { Form, SubmitButton, TextField } from "@grasp-os/app-kit/form";
import { v } from "@grasp-os/runtime/app";
import { useForm } from "@grasp-os/runtime/react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { submissionRefused } from "./frame-refusals.ts";
import { rendered, testHost } from "./test-host.tsx";

const contact = v.object({ name: v.string().trim().min(1) });

const ContactForm = ({ saved }: { saved: unknown[] }) => {
  const form = useForm(contact, {
    defaultValues: { name: "Ada" },
    onSubmit: (values) => {
      saved.push(values);
    },
  });
  return (
    <Form form={form}>
      <TextField form={form} label="Name" name="name" />
      <SubmitButton form={form}>Save contact</SubmitButton>
    </Form>
  );
};

describe("the kit's form, where nothing fires a submit event", () => {
  beforeEach(() => {
    window.addEventListener("submit", submissionRefused, true);
  });
  afterEach(() => {
    window.removeEventListener("submit", submissionRefused, true);
  });

  it("submits on its submit button's click", async () => {
    const saved: unknown[] = [];
    const { client } = testHost(() => ({ value: null }));
    await rendered(client, <ContactForm saved={saved} />);

    await userEvent.click(page.getByRole("button", { name: "Save contact" }));

    await expect.poll(() => saved).toStrictEqual([{ name: "Ada" }]);
  });

  it("submits on Enter in a text field", async () => {
    const saved: unknown[] = [];
    const { client } = testHost(() => ({ value: null }));
    await rendered(client, <ContactForm saved={saved} />);

    const name = page.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "Grace");
    await userEvent.type(name, "{Enter}");

    await expect.poll(() => saved).toStrictEqual([{ name: "Grace" }]);
  });
});
