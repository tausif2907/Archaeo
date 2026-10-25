import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxConfig, TestRunSummary } from "@archaeo/shared";
import { exec } from "./exec";
import { summarizeRun } from "./results";

export interface PrepareInput {
  /** Local clone the worktree is created from */
  repoDir: string;
  sha: string;
  /** Used in the image name, e.g. "pallets/click" */
  repoName: string;
  config: SandboxConfig;
  files: Record<string, string>;
}

export interface TestRun extends TestRunSummary {
  outputTail: string;
}

/** One isolated copy of the repo at a commit, plus a way to run its tests. */
export interface SandboxSession {
  readonly dir: string;
  readonly sha: string;
  applyPatch(diff: string): Promise<{ ok: boolean; output: string }>;
  /** Back to the clean base commit */
  reset(): Promise<void>;
  /** Full suite, or specific test files */
  runTests(files?: string[]): Promise<TestRun>;
  dispose(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  prepare(input: PrepareInput, onPhase?: (phase: string) => void): Promise<SandboxSession>;
}

const OUTPUT_TAIL = 8_000;

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export function imageTag(repoName: string, config: SandboxConfig, files: Record<string, string>): string {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const key = createHash("sha256")
    .update(JSON.stringify({ base: config.baseImage, sys: config.systemPackages, install: config.install, files: Object.entries(files).sort() }))
    .digest("hex")
    .slice(0, 16);
  return `archaeo-sbx-${slug}:${key}`;
}

export function dockerfile(config: SandboxConfig): string {
  const lines = [`FROM ${config.baseImage}`];
  if (config.systemPackages.length) {
    lines.push(`RUN apt-get update && apt-get install -y --no-install-recommends ${config.systemPackages.join(" ")} && rm -rf /var/lib/apt/lists/*`);
  }
  lines.push("WORKDIR /deps", "COPY . /deps/");
  for (const step of config.install) lines.push(`RUN ${step}`);
  lines.push("WORKDIR /work");
  return `${lines.join("\n")}\n`;
}

/**
 * Docker-backed sandbox: an image per repo + dependency set (cached by content hash), a fresh git
 * worktree per session, and test runs with no network and capped memory, CPU and processes.
 */
export class DockerSandbox implements SandboxProvider {
  readonly name = "docker";

  constructor(
    private readonly opts: { docker?: string; memory?: string; cpus?: string; pids?: number; buildTimeoutMs?: number } = {},
  ) {}

  private get docker() {
    return this.opts.docker ?? "docker";
  }

  /** Fails fast with a clear message when the Docker daemon isn't reachable. */
  async checkAvailable(): Promise<void> {
    const r = await exec(this.docker, ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
    if (r.exitCode !== 0) {
      throw new SandboxUnavailableError(
        `Docker is not available (${r.output.trim().split("\n").pop() || `exit code ${r.exitCode}`}). Start Docker Desktop or the Docker daemon, then try the fix again.`,
      );
    }
  }

  async ensureImage(input: PrepareInput, onPhase?: (phase: string) => void): Promise<string> {
    await this.checkAvailable();
    const tag = imageTag(input.repoName, input.config, input.files);
    if ((await exec(this.docker, ["image", "inspect", tag])).exitCode === 0) return tag;

    onPhase?.("Building the sandbox image (installing test dependencies)");
    const ctx = await mkdtemp(join(tmpdir(), "archaeo-img-"));
    try {
      for (const [path, content] of Object.entries(input.files)) {
        await mkdir(dirname(join(ctx, path)), { recursive: true });
        await writeFile(join(ctx, path), content);
      }
      await writeFile(join(ctx, "Dockerfile"), dockerfile(input.config));
      const r = await exec(this.docker, ["build", "-t", tag, ctx], { timeoutMs: this.opts.buildTimeoutMs ?? 20 * 60_000 });
      if (r.exitCode !== 0) throw new Error(`Sandbox image build failed:\n${r.output.slice(-4000)}`);
      return tag;
    } finally {
      await rm(ctx, { recursive: true, force: true });
    }
  }

  async prepare(input: PrepareInput, onPhase?: (phase: string) => void): Promise<SandboxSession> {
    const tag = await this.ensureImage(input, onPhase);
    onPhase?.(`Checking out ${input.sha.slice(0, 7)} in a fresh worktree`);
    const dir = await mkdtemp(join(tmpdir(), "archaeo-sbx-"));
    await rm(dir, { recursive: true, force: true });
    const add = await exec("git", ["-C", input.repoDir, "worktree", "add", "--detach", dir, input.sha]);
    if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${add.output.trim()}`);

    const git = (...args: string[]) => exec("git", ["-C", dir, ...args]);
    const { config } = input;
    const docker = this.docker;
    const limits = ["--memory", this.opts.memory ?? "2g", "--cpus", this.opts.cpus ?? "2", "--pids-limit", String(this.opts.pids ?? 512)];

    return {
      dir,
      sha: input.sha,
      async applyPatch(diff) {
        const file = join(dir, `.archaeo-${randomBytes(4).toString("hex")}.patch`);
        await writeFile(file, diff);
        const r = await git("apply", "--recount", "--whitespace=nowarn", file);
        await rm(file, { force: true });
        return { ok: r.exitCode === 0, output: r.output.trim() };
      },
      async reset() {
        await git("checkout", "--force", input.sha);
        await git("clean", "-fdx");
      },
      async runTests(files) {
        const command = files?.length ? config.testFiles.replace("{files}", files.map((f) => `'${f.replace(/'/g, "")}'`).join(" ")) : config.test;
        const name = `archaeo-run-${randomBytes(6).toString("hex")}`;
        const envArgs = Object.entries(config.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
        const r = await exec(
          docker,
          ["run", "--rm", "--name", name, "--network", "none", ...limits, "--mount", `type=bind,source=${dir},target=/work`, "-w", "/work", ...envArgs, tag, "sh", "-c", command],
          { timeoutMs: config.timeoutSeconds * 1000, onTimeout: async () => void (await exec(docker, ["kill", name])) },
        );
        return { ...summarizeRun(r, config), outputTail: r.output.slice(-OUTPUT_TAIL) };
      },
      async dispose() {
        await exec("git", ["-C", input.repoDir, "worktree", "remove", "--force", dir]);
        await exec("git", ["-C", input.repoDir, "worktree", "prune"]);
        await rm(dir, { recursive: true, force: true });
      },
    };
  }
}
