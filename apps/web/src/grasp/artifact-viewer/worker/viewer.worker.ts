import { serve } from "./serve";
// The core viewer's Worker: it runs the tasks in tasks.ts off the page's thread, one message each,
// and answers with the result or the error. An item's Worker (Markdown, CSV, code) is this file with
// its own tasks: `serve` is shared.
import { run } from "./tasks";

serve(run);
