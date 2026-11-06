import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import type { Target } from "./items.ts";

// A link to what an inbox item is about, as the prototype's
// (`components/target-link.tsx`): here a workflow, an engine, an App's
// page (on one of its pages), an integration's account, a chat, the
// brain, or a decision's own page.

export const TargetLink = ({
  destination,
  ...props
}: { destination: Target } & Omit<ComponentProps<"a">, "href">) => {
  if (destination.kind === "independentWorkflow") {
    return (
      <Link
        params={{ workflow: destination.workflow }}
        search={destination.tab === undefined ? {} : { tab: destination.tab }}
        to="/workflows/$workflow"
        {...props}
      />
    );
  }
  if (destination.kind === "engine") {
    const { engine: app, place } = destination;
    if (place === undefined) {
      return <Link params={{ app }} to="/apps/$app" {...props} />;
    }
    return (
      <Link
        params={{ app }}
        search={{ section: place }}
        to="/apps/$app/settings"
        {...props}
      />
    );
  }
  if (destination.kind === "app") {
    return (
      <Link params={{ app: destination.app }} to="/apps/$app" {...props} />
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
  if (destination.kind === "brain") {
    return <Link to="/brain" {...props} />;
  }
  if (destination.kind === "decision") {
    return (
      <Link
        params={{ decision: destination.decision }}
        to="/decisions/$decision"
        {...props}
      />
    );
  }
  return <Link search={{ chat: destination.chat }} to="/" {...props} />;
};
