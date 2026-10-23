import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "dotenv";

/** Walks up from `start` to the directory containing pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Loads the root `.env` once. Real environment variables win over the file. */
export function loadEnv(): void {
  const file = join(findRepoRoot(), ".env");
  if (existsSync(file)) config({ path: file, quiet: true });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
