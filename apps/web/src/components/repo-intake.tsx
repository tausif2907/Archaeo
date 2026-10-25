"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { parseGitHubUrl, type RepoDto } from "@archaeo/shared";
import { API_URL, api } from "@/lib/api";
import { STATUS_STYLES } from "./repo-status";

export function RepoIntake() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [repos, setRepos] = useState<RepoDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [apiDown, setApiDown] = useState(false);

  useEffect(() => {
    api.listRepos().then(setRepos, () => setApiDown(true));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!parseGitHubUrl(url)) {
      setError("Enter a GitHub repository URL, e.g. https://github.com/pallets/click");
      return;
    }
    setSubmitting(true);
    try {
      const repo = await api.createRepo(url);
      router.push(`/repos/${repo.id}`);
    } catch (err) {
      setError(err instanceof Error ? `Could not reach the Archaeo API: ${err.message}` : String(err));
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-8">
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
      {apiDown && !error && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Can&apos;t reach the Archaeo API at {API_URL}. Start it with <code className="font-mono">pnpm dev</code>.
        </p>
      )}

      {repos.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-stone-500">Recent</h2>
          <ul className="divide-y divide-stone-200 overflow-hidden rounded-xl border border-stone-200 bg-white dark:divide-stone-800 dark:border-stone-800 dark:bg-stone-900">
            {repos.map((r) => (
              <li key={r.id}>
                <Link href={`/repos/${r.id}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-stone-50 dark:hover:bg-stone-800/50">
                  <span className="min-w-0 truncate font-medium">
                    {r.owner}/{r.name}
                  </span>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[r.status]}`}>{r.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
