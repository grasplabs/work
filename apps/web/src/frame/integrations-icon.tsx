import type { ComponentProps } from "react";

/**
 * Integrations: three apps, linked in a flow. Drawn on Lucide's 24-unit
 * grid with its 2px round stroke, so it sits with the sidebar's other
 * icons; it moves as they do when pointed at (`links` in icon-moves.css).
 * From the prototype's components/integrations-icon.tsx.
 */
export const IntegrationsIcon = (props: ComponentProps<"svg">) => (
  <svg
    aria-hidden="true"
    data-moves="links"
    fill="none"
    height="24"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="24"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <rect height="6" rx="1.5" width="6" x="2.5" y="2.5" />
    <rect height="6" rx="1.5" width="6" x="9" y="9" />
    <rect height="6" rx="1.5" width="6" x="15.5" y="15.5" />
    <path d="M11 5.5h6a3 3 0 0 1 3 3v.5a3 3 0 0 1-3 3h-.5" />
    <path d="M13 18.5H7a3 3 0 0 1-3-3v-.5a3 3 0 0 1 3-3h.5" />
  </svg>
);
