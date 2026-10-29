"use client";

import { useEffect, useState } from "react";
import type { RepoProgressDto, RepoStatus, StageProgress } from "@archaeo/shared";
import Link from "next/link";
import { API_URL, api } from "@/lib/api";
import { useAppConfig } from "@/lib/use-config";

/** `data-tone` for a status chip: ready is ok, ingesting is the current step, failed is bad. */
export const STATUS_TONES: Record<RepoStatus, "ok" | "bad" | "accent" | undefined> = {
  queued: undefined,
  ingesting: "accent",
  ready: "ok",
  failed: "bad",
};

const STAGE_LABELS: Record<StageProgress["name"], string> = {
  clone: "Clone",
  parse: "Parse",
  history: "History",
  embed: "Embed",
  summarize: "Summarize",
};

const BAR_STYLES: Record<StageProgress["state"], string> = {
  pending: "bg-rule",
  active: "bg-accent",
  done: "bg-ok",
  failed: "bg-bad",
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
    <li className="min-w-0 flex-1 space-y-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-rule">
        <div
          className={`h-full origin-left rounded-full transition-transform duration-500 ease-out ${BAR_STYLES[stage.state]} ${indeterminate ? "motion-safe:animate-pulse" : ""}`}
          style={{ transform: `scaleX(${(indeterminate ? 100 : fill) / 100})` }}
        />
      </div>
      <div className="text-xs">
        <span className={stage.state === "pending" ? "text-muted" : "font-medium text-ink"}>{STAGE_LABELS[stage.name]}</span>
        {detail && <span className="measured block truncate text-muted">{detail}</span>}
      </div>
    </li>
  );
}

/** Ingest progress and the repo's readings. Polls until the repo is ready or failed. */
export function RepoStatusCard({ repoId, onProgress }: { repoId: string; onProgress?: (p: RepoProgressDto) => void }) {
  const [progress, setProgress] = useState<RepoProgressDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const publicDemo = useAppConfig()?.publicDemo === true;
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
      <article className="panel max-w-2xl space-y-4 p-6">
        <h1 className="text-xl">{notFound ? "Repository not found" : "Can't reach the Archaeo API"}</h1>
        <p className="text-ink-2">
          {notFound ? "This repository isn't in Archaeo. Add it from the home page." : `${error}. Check that the API is running (pnpm dev) and reachable at ${API_URL}.`}
        </p>
        <Link href="/" className="btn">
          Back to Archaeo
        </Link>
      </article>
    );
  }
  if (!progress) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Loading the repository">
        <div className="skeleton h-12 w-80 max-w-full motion-safe:animate-pulse" />
        <div className="skeleton h-20 motion-safe:animate-pulse" />
      </div>
    );
  }

  const { repo, counts } = progress;
  return (
    <section className="space-y-6" aria-labelledby="repo-heading">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1">
          <h1 id="repo-heading" className="truncate">
            {repo.owner}/{repo.name}
          </h1>
          <a href={repo.url} target="_blank" rel="noreferrer" className="link measured text-sm">
            {repo.url}
          </a>
        </div>
        <div className="flex items-center gap-3">
          <span className="chip" data-tone={STATUS_TONES[repo.status]} role="status">
            {repo.status}
          </span>
          {settled && !publicDemo && (
            <button type="button" onClick={onReingest} className="btn">
              Re-ingest
            </button>
          )}
        </div>
      </div>

      {!(repo.status === "ready") && (
        <ol className="flex gap-3" aria-label="Ingest progress">
          {progress.stages.map((s) => (
            <StageBar key={s.name} stage={s} />
          ))}
        </ol>
      )}

      {repo.statusMessage && <p className={`text-sm ${repo.status === "failed" ? "text-bad" : "text-ink-2"}`}>{repo.statusMessage}</p>}
      {error && <p className="text-sm text-bad">{error}</p>}

      {repo.status === "ready" && (
        <dl className="panels grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
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
            <div key={label} className="space-y-1 px-4 py-3">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="measured text-xl leading-none text-ink">{fmt(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
