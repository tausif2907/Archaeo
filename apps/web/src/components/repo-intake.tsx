"use client";

import { useEffect, useState, type FormEvent } from "react";
import { parseGitHubUrl, type RepoProgressDto, type RepoStatus, type StageProgress } from "@archaeo/shared";
import { api } from "@/lib/api";

const STATUS_STYLES: Record<RepoStatus, string> = {
  queued: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  ingesting: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const STAGE_LABELS: Record<StageProgress["name"], string> = {
  clone: "Clone",
  parse: "Parse",
  history: "History",
  embed: "Embed",
  summarize: "Summarize",
};

const BAR_STYLES: Record<StageProgress["state"], string> = {
  pending: "bg-stone-200 dark:bg-stone-800",
  active: "bg-amber-400 dark:bg-amber-500",
  done: "bg-emerald-500 dark:bg-emerald-600",
  failed: "bg-red-500",
};

const fmt = (n: number) => n.toLocaleString("en-US");

function stageDetail(stage: StageProgress): string | null {
  if (stage.done === null) return null;
  return stage.total === null ? fmt(stage.done) : `${fmt(stage.done)} / ${fmt(stage.total)}`;
}

function StageBar({ stage }: { stage: StageProgress }) {
  const fill =
    stage.state === "done" ? 100 : stage.state === "active" && stage.total ? Math.round(((stage.done ?? 0) / stage.total) * 100) : stage.state === "pending" ? 0 : 100;
  const detail = stageDetail(stage);
  return (
    <li className="min-w-0 flex-1 space-y-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
        <div
          className={`h-full rounded-full transition-all duration-500 ${BAR_STYLES[stage.state]} ${stage.state === "active" && !stage.total ? "animate-pulse" : ""}`}
          style={{ width: `${stage.state === "active" && !stage.total ? 100 : fill}%` }}
        />
      </div>
      <div className="text-xs">
        <span className={stage.state === "pending" ? "text-stone-400 dark:text-stone-600" : "font-medium"}>{STAGE_LABELS[stage.name]}</span>
        {detail && <span className="block truncate tabular-nums text-stone-500">{detail}</span>}
      </div>
    </li>
  );
}

export function RepoIntake() {
  const [url, setUrl] = useState("");
  const [progress, setProgress] = useState<RepoProgressDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const repo = progress?.repo;
  const settled = repo?.status === "ready" || repo?.status === "failed";

  // Poll while the repo is moving through the pipeline.
  useEffect(() => {
    if (!repo || settled) return;
    const timer = setInterval(() => {
      api.getProgress(repo.id).then(setProgress, (err: Error) => setError(err.message));
    }, 1500);
    return () => clearInterval(timer);
  }, [repo, settled]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!parseGitHubUrl(url)) {
      setError("Enter a GitHub repository URL, e.g. https://github.com/pallets/click");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.createRepo(url);
      setProgress(await api.getProgress(created.id));
    } catch (err) {
      setError(err instanceof Error ? `Could not reach the Archaeo API: ${err.message}` : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onReingest() {
    if (!repo) return;
    setError(null);
    try {
      await api.reingest(repo.id);
      setProgress(await api.getProgress(repo.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const counts = progress?.counts;

  return (
    <section className="space-y-6">
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="repo-url" className="sr-only">
          GitHub repository URL
        </label>
        <input
          id="repo-url"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-900"
        />
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-stone-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
        >
          {submitting ? "Adding…" : "Excavate"}
        </button>
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {repo && progress && (
        <article className="space-y-5 rounded-xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-medium">
                {repo.owner}/{repo.name}
              </h2>
              <a href={repo.url} target="_blank" rel="noreferrer" className="text-sm text-stone-500 hover:underline">
                {repo.url}
              </a>
            </div>
            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[repo.status]}`}>{repo.status}</span>
          </div>

          <ol className="flex gap-2" aria-label="Ingest progress">
            {progress.stages.map((s) => (
              <StageBar key={s.name} stage={s} />
            ))}
          </ol>

          {repo.statusMessage && (
            <p className={`text-sm ${repo.status === "failed" ? "text-red-600 dark:text-red-400" : "text-stone-600 dark:text-stone-400"}`}>
              {repo.statusMessage}
            </p>
          )}

          {repo.status === "ready" && counts && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-stone-200 pt-4 text-sm sm:grid-cols-4 dark:border-stone-800">
              {(
                [
                  ["Files", counts.files],
                  ["Lines", counts.loc],
                  ["Symbols", counts.symbols],
                  ["Imports", counts.importEdges],
                  ["Calls", counts.callEdges],
                  ["Commits", counts.commits],
                  ["Merged PRs", counts.pullRequests],
                  ["Issues", counts.issues],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-stone-500">{label}</dt>
                  <dd className="font-medium tabular-nums">{fmt(value)}</dd>
                </div>
              ))}
            </dl>
          )}

          {settled && (
            <button type="button" onClick={onReingest} className="text-sm font-medium text-stone-600 underline-offset-4 hover:underline dark:text-stone-400">
              Re-ingest
            </button>
          )}
        </article>
      )}
    </section>
  );
}
