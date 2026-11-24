import { spawn } from "node:child_process";

/**
 * Runs a Node script in a process of its own without blocking this one,
 * so the global setup's builds run at once. Its output is shown
 * (`inherit`), or kept and shown only in the error if it fails (`quiet`).
 */
export const runNode = async (
  args: readonly string[],
  { cwd, output }: { cwd?: string; output: "inherit" | "quiet" }
): Promise<void> => {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: output === "inherit" ? "inherit" : "pipe",
  });
  let kept = "";
  const keep = (chunk: string): void => {
    kept += chunk;
  };
  child.stdout?.setEncoding("utf-8").on("data", keep);
  child.stderr?.setEncoding("utf-8").on("data", keep);
  const { promise, resolve, reject } = Promise.withResolvers<null>();
  child.on("error", reject);
  child.on("close", (code, signal) => {
    if (code === 0) {
      resolve(null);
      return;
    }
    const ended = signal === null ? `exited with ${code}` : `got ${signal}`;
    reject(new Error(`node ${args.join(" ")} ${ended}\n${kept}`));
  });
  await promise;
};
