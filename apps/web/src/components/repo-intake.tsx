"use client";

import { useEffect, useState, type FormEvent } from "react";
import { parseGitHubUrl, type RepoDto, type RepoStatus } from "@archaeo/shared";
import { api } from "@/lib/api";

const STATUS_STYLES: Record<RepoStatus, string> = {
  queued: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  ingesting: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export function RepoIntake() {
  const [url, setUrl] = useState("");
  const [repo, setRepo] = useState<RepoDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Poll while the repo is still moving through the pipeline.
  useEffect(() => {
    if (!repo || repo.status === "ready" || repo.status === "failed") return;
    const timer = setInterval(() => {
      api.getRepo(repo.id).then(setRepo, (err: Error) => setError(err.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [repo]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!parseGitHubUrl(url)) {
      setError("Enter a GitHub repository URL, e.g. https://github.com/pallets/click");
      return;
    }
    setSubmitting(true);
    try {
      setRepo(await api.createRepo(url));
    } catch (err) {
      setError(err instanceof Error ? `Could not reach the Archaeo API: ${err.message}` : String(err));
    } finally {
      setSubmitting(false);
    }
  }

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

      {repo && (
        <article className="rounded-xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-medium">
                {repo.owner}/{repo.name}
              </h2>
              <a href={repo.url} target="_blank" rel="noreferrer" className="text-sm text-stone-500 hover:underline">
                {repo.url}
              </a>
            </div>
            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[repo.status]}`}>
              {repo.status}
            </span>
          </div>
          {repo.statusMessage && <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">{repo.statusMessage}</p>}
        </article>
      )}
    </section>
  );
}
