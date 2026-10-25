import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  /** stdout and stderr interleaved, keeping only the last `maxOutput` characters */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxOutput?: number;
  /** Called on timeout before the process is killed (e.g. `docker kill <name>`) */
  onTimeout?: () => Promise<void> | void;
}

/** Runs a command without a shell. Never rejects on non-zero exit; check `exitCode`. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const max = opts.maxOutput ?? 200_000;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > max * 2) output = output.slice(-max);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = opts.timeoutMs
      ? setTimeout(async () => {
          timedOut = true;
          await opts.onTimeout?.();
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 127, output: `${output}\n${err.message}`.slice(-max), timedOut, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? (timedOut ? 124 : 1), output: output.slice(-max), timedOut, durationMs: Date.now() - started });
    });
  });
}
