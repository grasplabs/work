import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import type { Target } from "./items.ts";

// A link to what an inbox item is about, as the prototype's
// (`components/target-link.tsx`): here a workflow, an engine, an
// integration's account, or a chat.

export const TargetLink = ({
  destination,
  ...props
}: { destination: Target } & Omit<ComponentProps<"a">, "href">) => {
  if (destination.kind === "workflow") {
    return (
      <Link
        params={{ app: destination.app, workflow: destination.workflow }}
        to="/workflows/$app/$workflow"
        {...props}
      />
    );
  }
  if (destination.kind === "engine") {
    return (
      <Link
        params={{ engine: destination.engine }}
        to="/engines/$engine"
        {...props}
      />
    );
  }
  if (destination.kind === "integration") {
    return (
      <Link
        params={{ integration: destination.integration }}
        search={{ tab: "account" }}
        to="/integrations/$integration"
        {...props}
      />
    );
  }
  return <Link search={{ chat: destination.chat }} to="/" {...props} />;
};
