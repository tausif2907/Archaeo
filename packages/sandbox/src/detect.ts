import type { SandboxConfig } from "@archaeo/shared";
import { exec } from "./exec";

export interface DetectedSandbox {
  config: SandboxConfig;
  /** Contents of `config.depsFiles` at the commit, for the image build context */
  files: Record<string, string>;
}

async function gitFiles(repoDir: string, sha: string): Promise<string[]> {
  const r = await exec("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", sha]);
  if (r.exitCode !== 0) throw new Error(`git ls-tree failed: ${r.output.trim()}`);
  return r.output.split("\n").filter(Boolean);
}

async function gitShow(repoDir: string, sha: string, path: string): Promise<string> {
  const r = await exec("git", ["-C", repoDir, "show", `${sha}:${path}`], { maxOutput: 5_000_000 });
  if (r.exitCode !== 0) throw new Error(`git show ${path} failed: ${r.output.trim()}`);
  return r.output;
}

/** Names of `[dependency-groups]` entries in a pyproject.toml (no TOML parser needed for this). */
export function dependencyGroups(pyproject: string): string[] {
  const section = /^\[dependency-groups\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
  return [...section.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]!);
}

/** Test groups to install: an exact `tests`/`test` group, else any group mentioning "test". */
export function testGroups(groups: string[]): string[] {
  const exact = groups.filter((g) => g === "tests" || g === "test");
  return exact.length ? exact : groups.filter((g) => g.includes("test")).slice(0, 1);
}

const PYTEST = "python -m pytest -q -p no:cacheprovider -rfE";
/** Offline editable install of the worktree; on failure tests still run from PYTHONPATH. */
const INSTALL_SELF =
  'pip install -q --no-deps --no-build-isolation --no-index -e . > /tmp/archaeo-install.log 2>&1 || { echo "[archaeo] editable install failed, using PYTHONPATH:"; tail -n 5 /tmp/archaeo-install.log; };';

/**
 * Works out how to install and run a repo's tests at a commit. Test dependencies come from the lock file
 * when there is one (pinned versions avoid tool drift breaking old commits), else requirements files.
 */
export async function detectSandboxConfig(repoDir: string, sha: string, timeoutSeconds = 600): Promise<DetectedSandbox | null> {
  const all = await gitFiles(repoDir, sha);
  const has = (p: string) => all.includes(p);

  if (has("pyproject.toml") || has("setup.py") || has("setup.cfg")) {
    const depsFiles: string[] = [];
    const install: string[] = [];
    const pyproject = has("pyproject.toml") ? await gitShow(repoDir, sha, "pyproject.toml") : "";
    if (pyproject) depsFiles.push("pyproject.toml");

    const reqFiles = all.filter((p) => /^(requirements\/[^/]*test[^/]*\.txt|requirements[-_](dev|test)s?\.txt|test[-_]requirements\.txt|dev[-_]requirements\.txt)$/i.test(p));
    if (pyproject && has("uv.lock")) {
      depsFiles.push("uv.lock");
      const groups = testGroups(dependencyGroups(pyproject)).map((g) => `--group ${g}`).join(" ");
      install.push(
        `pip install --no-cache-dir uv && uv export --frozen --no-hashes --no-emit-project ${groups} -o /deps/requirements.txt && pip install --no-cache-dir -r /deps/requirements.txt`.replace(/ +/g, " "),
      );
    } else if (reqFiles.length) {
      // Requirement files may include each other, so copy the whole requirements/ folder when used.
      const extra = all.filter((p) => p.startsWith("requirements/") && p.endsWith(".txt"));
      depsFiles.push(...new Set([...reqFiles, ...extra]));
      install.push(`pip install --no-cache-dir ${reqFiles.map((f) => `-r ${f}`).join(" ")}`);
    } else if (pyproject) {
      install.push(
        `python -c "import tomllib;d=tomllib.load(open('pyproject.toml','rb'));print(chr(10).join(d.get('project',{}).get('dependencies',[])))" > /deps/requirements.txt && pip install --no-cache-dir -r /deps/requirements.txt`,
      );
    }
    install.push(`python -c "import pytest" 2>/dev/null || pip install --no-cache-dir pytest`);
    // The build backend lets each run install the project itself offline (tests may read package metadata).
    install.push(
      pyproject
        ? `python -c "import tomllib;print(chr(10).join(tomllib.load(open('pyproject.toml','rb')).get('build-system',{}).get('requires',['setuptools','wheel'])))" > /deps/build-requires.txt && pip install --no-cache-dir -r /deps/build-requires.txt`
        : "pip install --no-cache-dir setuptools wheel",
    );

    const files: Record<string, string> = {};
    for (const f of depsFiles) files[f] = await gitShow(repoDir, sha, f);
    const srcLayout = all.some((p) => p.startsWith("src/"));
    return {
      config: {
        language: "python",
        baseImage: "python:3.12-slim",
        systemPackages: ["git", "less"],
        install,
        depsFiles,
        test: `${INSTALL_SELF} ${PYTEST}`,
        testFiles: `${INSTALL_SELF} ${PYTEST} {files}`,
        env: { PYTHONPATH: srcLayout ? "src:." : ".", PYTHONDONTWRITEBYTECODE: "1" },
        timeoutSeconds,
      },
      files,
    };
  }

  if (has("package.json")) {
    const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].find(has);
    const depsFiles = ["package.json", ...(lock ? [lock] : [])];
    const install =
      lock === "pnpm-lock.yaml"
        ? ["corepack enable && pnpm install --frozen-lockfile --ignore-scripts"]
        : lock === "yarn.lock"
          ? ["corepack enable && yarn install --frozen-lockfile --ignore-scripts"]
          : [lock ? "npm ci --ignore-scripts" : "npm install --ignore-scripts"];
    const files: Record<string, string> = {};
    for (const f of depsFiles) files[f] = await gitShow(repoDir, sha, f);
    // node_modules is installed in the image and linked into the (gitignored) worktree at run time.
    const link = "ln -sfn /deps/node_modules node_modules &&";
    return {
      config: {
        language: "node",
        baseImage: "node:22-slim",
        systemPackages: ["git"],
        install,
        depsFiles,
        test: `${link} npm test --silent`,
        testFiles: `${link} npm test --silent -- {files}`,
        env: { CI: "1" },
        timeoutSeconds,
      },
      files,
    };
  }
  return null;
}
