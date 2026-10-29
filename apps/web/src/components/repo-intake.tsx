"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { parseGitHubUrl, type RepoDto } from "@archaeo/shared";
import { API_URL, api } from "@/lib/api";
import { useAppConfig } from "@/lib/use-config";
import { STATUS_TONES } from "./repo-status";

export function RepoIntake() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [repos, setRepos] = useState<RepoDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [apiDown, setApiDown] = useState(false);
  const publicDemo = useAppConfig()?.publicDemo === true;

  useEffect(() => {
    api.listRepos().then(setRepos, () => {
      setRepos([]);
      setApiDown(true);
    });
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
    <section className="contents" aria-label="Repositories">
      <div className="space-y-4 lg:col-span-5 lg:row-start-2">
        {publicDemo ? (
          <p className="well px-4 py-3 text-sm text-ink-2">
            This public demo explores the repositories listed here, which are already ingested. To excavate your own, run Archaeo locally.
          </p>
        ) : (
          <form onSubmit={onSubmit}>
            <label htmlFor="repo-url" className="label">
              GitHub repository URL
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="repo-url"
                type="text"
                inputMode="url"
                autoComplete="off"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "repo-url-error" : undefined}
                className="field measured flex-1"
              />
              <button type="submit" disabled={submitting} aria-busy={submitting || undefined} className="btn btn--primary">
                {submitting ? "Adding…" : "Excavate"}
              </button>
            </div>
          </form>
        )}
        {error && (
          <p id="repo-url-error" className="text-sm text-bad" role="alert">
            {error}
          </p>
        )}
        {apiDown && !error && (
          <p className="rounded-pill border border-bad/40 bg-bad-soft px-3 py-2 text-sm text-ink" role="alert">
            Can&apos;t reach the Archaeo API at <span className="measured">{API_URL}</span>. Start it with <code className="measured text-ink">pnpm dev</code>.
          </p>
        )}
      </div>

      <div className="space-y-3 lg:col-span-6 lg:col-start-7 lg:row-span-2 lg:row-start-1">
        <h2 className="text-sm font-medium tracking-normal text-muted">Recent</h2>
        {repos === null ? (
          <div className="skeleton h-40 motion-safe:animate-pulse" aria-hidden="true" />
        ) : repos.length > 0 ? (
          <ul className="panels">
            {repos.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/repos/${r.id}`}
                  className="flex min-h-13 items-center justify-between gap-4 px-4 py-3 transition-colors duration-200 hover:bg-paper-hover active:bg-paper-3"
                >
                  <span className="min-w-0 truncate font-medium">
                    {r.owner}/{r.name}
                  </span>
                  <span className="chip" data-tone={STATUS_TONES[r.status]}>
                    {r.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          !apiDown && <p className="well px-4 py-6 text-sm text-muted">No repositories yet. Paste a GitHub URL to excavate the first one.</p>
        )}
      </div>
    </section>
  );
}
