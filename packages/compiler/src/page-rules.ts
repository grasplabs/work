/**
 * The lint rules a page and its components are held to beside Ultracite's
 * (ultracite-config.ts), each one of oxlint's own, configured with what to
 * do instead: what never works in a page's frame (a plain `<form>`, an
 * inline `style`), and what would reach past it (WebRTC, a nested
 * document's realm). The frame's sandbox, CSP and bootstrap hold all of
 * it at run time (core's security-headers.ts and page-frame.ts); these say
 * so where it is written, where it can be fixed.
 *
 * Imports nothing but data, as core reads which rules are the design
 * system's (diagnostic.ts `isDesignRule`).
 */
import {
  pageNestedDocuments,
  pagePeerInterfaces,
} from "@grasp-os/shared/pages";

/** What to do instead of reaching outside the frame. */
const insteadOfOut =
  "A page reaches outside its frame only through its App's functions.";

/** What to do instead of styling a page outside the kit. */
const insteadOfStyle =
  "Style pages with the kit's components and theme classes (@grasp-os/ui); for a value only known at run time, pick among classes.";

/** An inline style's refusal. */
const styleMessage = `An inline style styles the page outside the design system. ${insteadOfStyle}`;

/** The pages' own rules, by oxlint's name of each, at the level and options they run with. */
export const pageRules = {
  "react/forbid-elements": [
    "error",
    {
      forbid: [
        {
          element: "form",
          message:
            "A plain <form> never submits in a page: its frame doesn't allow forms, so its onSubmit never runs. Use Form from @grasp-os/ui/form (with useForm, the form's fields and SubmitButton), which submits itself.",
        },
        {
          element: "style",
          message: `A <style> element styles the page outside the design system. ${insteadOfStyle}`,
        },
        ...pageNestedDocuments.map((element) => ({
          element,
          message: `A nested document (<${element}>) gives the page a second realm, with its own WebRTC. ${insteadOfOut}`,
        })),
      ],
    },
  ],
  "react/forbid-dom-props": [
    "error",
    { forbid: [{ propName: "style", message: styleMessage }] },
  ],
  "react/forbid-component-props": [
    "error",
    { forbid: [{ propName: "style", message: styleMessage }] },
  ],
  "no-restricted-globals": [
    "error",
    ...pagePeerInterfaces.map((name) => ({
      name,
      message: `${name} opens a peer connection out of the page's frame, past what its App may reach. ${insteadOfOut}`,
    })),
  ],
  "no-restricted-properties": [
    "error",
    ...["contentWindow", "contentDocument", "getSVGDocument"].map(
      (property) => ({
        property,
        message: `${property} reaches a nested document's realm, with its own WebRTC. ${insteadOfOut}`,
      })
    ),
  ],
} as const;

/**
 * The names the pages' rules report under, as oxlint names a finding
 * (oxc.wasm `lint`): a plugin's rule by its plugin, a core rule alone.
 */
export const pageRuleNames: ReadonlySet<string> = new Set(
  Object.keys(pageRules)
);
