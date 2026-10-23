import { createFileRoute, redirect } from "@tanstack/react-router";

import { forgetChatLink, keepChatLink } from "../settings/chat-link.ts";

// Where a link a chat app sent leads (`/chat-link#<secret>`). It links
// nothing: chat apps open links to preview them. It moves the secret out
// of the address into the tab's storage and goes on to Settings ›
// Security, through sign-in if need be, where the person sees whose
// account it is and confirms.

export const Route = createFileRoute("/chat-link")({
  beforeLoad: () => {
    const secret = window.location.hash.slice(1);
    // A bare `/chat-link` offers nothing, not a link opened earlier.
    if (secret === "") {
      forgetChatLink();
    } else {
      keepChatLink(secret);
    }
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/settings/security", replace: true });
  },
});
