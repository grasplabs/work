import { describe, expect, it } from "vite-plus/test";

import { leanStylesheet } from "./lean-parts.ts";

// The lean pages' copy of the stylesheet keeps every rule they can need:
// those for the class names their modules hold, and every rule written by
// hand, used or not. It drops only what Tailwind's utilities layer and
// StyleX generated for classes nothing on those pages names, and keeps the
// rest in the whole stylesheet's order, so the whole can follow it.

const whole = [
  "@layer base{html{color:red}}",
  "@layer utilities{.flex{display:flex}.grid{display:grid}",
  "@media (width>=40rem){.sm\\:grid{display:grid}.sm\\:flex{display:flex}}}",
  ".painted-field{color:blue}",
  ".dark .painted-field{color:green}",
  ".x1abcde{margin:0}",
  ".x2fghij:not(#\\#){padding:0}",
  ".x3klmno:hover{color:red}",
  "@media (prefers-reduced-motion:reduce){.x4pqrst{transition:none}}",
].join("");

const lean = leanStylesheet(
  whole,
  new Set(["flex", "sm:grid", "x2fghij", "x3klmno"])
);

describe("the lean stylesheet", () => {
  it("keeps the generated rules a lean page's classes name, in order", () => {
    expect(lean).toBe(
      [
        "@layer base{html{color:red}}",
        "@layer utilities{.flex{display:flex}",
        "@media (width>=40rem){.sm\\:grid{display:grid}}}",
        ".painted-field{color:#00f}",
        ".dark .painted-field{color:green}",
        ".x2fghij:not(#\\#){padding:0}",
        ".x3klmno:hover{color:red}",
        "@media (prefers-reduced-motion:reduce){}",
      ].join("")
    );
  });
});
