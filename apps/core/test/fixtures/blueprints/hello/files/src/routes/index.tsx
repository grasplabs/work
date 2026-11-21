import {
  Form,
  FormError,
  SubmitButton,
  TextField,
} from "@grasp-os/app-kit/form";
import { useForm } from "@grasp-os/sdk/react";
import { api } from "@server/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

const Hello = () => {
  const [greeting, setGreeting] = useState<string | null>(null);
  const form = useForm(api.greetings.hello, {
    defaultValues: { name: "" },
    resetOnSuccess: true,
    onSuccess: (said) => {
      setGreeting(said);
    },
  });
  return (
    <main className="flex flex-col gap-4 p-6">
      <Form aria-label="Greet someone" form={form}>
        <TextField form={form} label="Name" name="name" />
        <FormError form={form} />
        <SubmitButton form={form}>Say hello</SubmitButton>
      </Form>
      <output>{greeting ?? "No greeting yet"}</output>
      <Link to="/greeted">Everyone greeted</Link>
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Hello });
