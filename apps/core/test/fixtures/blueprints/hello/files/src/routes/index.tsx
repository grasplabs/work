import { useMutation } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "@server/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

const Hello = () => {
  const hello = useMutation(api.greetings.hello);
  const [greeting, setGreeting] = useState<string | null>(null);
  const greet = async () => {
    setGreeting(await hello({ name: "you" }));
  };
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button
        onClick={() => {
          void greet();
        }}
        variant="outline"
      >
        Say hello
      </Button>
      <output>{greeting ?? "No greeting yet"}</output>
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Hello });
