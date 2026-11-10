import { stephenPartFile } from "./stephen-eval-parts.ts";

// Stephen's eval (GRA-720), the part of the cases this file's name says:
// stephen-eval-1-of-2.test.ts says what the eval is, and
// stephen-eval-parts.ts why it runs in parts.

stephenPartFile(import.meta.url);
