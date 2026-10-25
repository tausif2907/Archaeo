"use client";

import { useEffect, useState } from "react";
import type { RepoProgressDto, RepoStatus, StageProgress } from "@archaeo/shared";
import Link from "next/link";
import { API_URL, api } from "@/lib/api";

export const STATUS_STYLES: Record<RepoStatus, string> = {
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

export const fmt = (n: number) => n.toLocaleString("en-US");

function stageDetail(stage: StageProgress): string | null {
  if (stage.done === null) return null;
  return stage.total === null ? fmt(stage.done) : `${fmt(stage.done)} / ${fmt(stage.total)}`;
}

function StageBar({ stage }: { stage: StageProgress }) {
  const indeterminate = stage.state === "active" && !stage.total;
  const fill = stage.state === "pending" ? 0 : stage.state === "active" && stage.total ? Math.round(((stage.done ?? 0) / stage.total) * 100) : 100;
  const detail = stageDetail(stage);
  return (
    <li className="min-w-0 flex-1 space-y-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
        <div
          className={`h-full rounded-full transition-all duration-500 ${BAR_STYLES[stage.state]} ${indeterminate ? "animate-pulse" : ""}`}
          style={{ width: `${indeterminate ? 100 : fill}%` }}
        />
      </div>
      <div className="text-xs">
        <span className={stage.state === "pending" ? "text-stone-400 dark:text-stone-600" : "font-medium"}>{STAGE_LABELS[stage.name]}</span>
        {detail && <span className="block truncate tabular-nums text-stone-500">{detail}</span>}
      </div>
    </li>
  );
}

/** Ingest progress card. Polls until the repo is ready or failed, then calls `onSettled`. */
export function RepoStatusCard({ repoId, onProgress }: { repoId: string; onProgress?: (p: RepoProgressDto) => void }) {
  const [progress, setProgress] = useState<RepoProgressDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = progress?.repo.status;
  const settled = status === "ready" || status === "failed";

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.getProgress(repoId).then(
        (p) => {
          if (cancelled) return;
          setProgress(p);
          setError(null);
          onProgress?.(p);
        },
        (err: Error) => !cancelled && setError(err.message),
      );
    load();
    if (settled) return () => void (cancelled = true);
    const timer = setInterval(load, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [repoId, settled]);

  async function onReingest() {
    setError(null);
    try {
      await api.reingest(repoId);
      setProgress(await api.getProgress(repoId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!progress && error) {
    const notFound = /not found/i.test(error);
    return (
      <article className="space-y-3 rounded-xl border border-red-200 bg-white p-5 dark:border-red-900 dark:bg-stone-900">
        <h1 className="text-lg font-semibold">{notFound ? "Repository not found" : "Can't reach the Archaeo API"}</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          {notFound ? "This repository isn't in Archaeo. Add it from the home page." : `${error}. Check that the API is running (pnpm dev) and reachable at ${API_URL}.`}
        </p>
        <Link href="/" className="inline-block text-sm font-medium underline-offset-4 hover:underline">
          ← Back to Archaeo
        </Link>
      </article>
    );
  }
  if (!progress) {
    return <div className="h-40 animate-pulse rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900" />;
  }

  const { repo, counts } = progress;
  return (
    <article className="space-y-5 rounded-xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">
            {repo.owner}/{repo.name}
          </h1>
          <a href={repo.url} target="_blank" rel="noreferrer" className="text-sm text-stone-500 hover:underline">
            {repo.url}
          </a>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[repo.status]}`}>{repo.status}</span>
      </div>

      {!(repo.status === "ready") && (
        <ol className="flex gap-2" aria-label="Ingest progress">
          {progress.stages.map((s) => (
            <StageBar key={s.name} stage={s} />
          ))}
        </ol>
      )}

      {repo.statusMessage && (
        <p className={`text-sm ${repo.status === "failed" ? "text-red-600 dark:text-red-400" : "text-stone-600 dark:text-stone-400"}`}>{repo.statusMessage}</p>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {repo.status === "ready" && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          {(
            [
              ["Files", counts.files],
              ["Lines", counts.loc],
              ["Symbols", counts.symbols],
              ["Call edges", counts.callEdges],
              ["Commits", counts.commits],
              ["Merged PRs", counts.pullRequests],
              ["Issues", counts.issues],
              ["Chunks", counts.chunks],
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
  );
}
