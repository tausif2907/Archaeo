"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { FileEntry, SymbolEntry, WhyCommit, WhyResult } from "@archaeo/shared";
import { api } from "@/lib/api";
import { CitedText } from "./cited-text";

/** One entry on the history trail: what changed in ink, the commit and its PRs in amber, the date in cool. */
function CommitRow({ label, c, repoUrl }: { label?: string; c: WhyCommit; repoUrl: string }) {
  return (
    <li className="space-y-1">
      <p className="text-ink">
        {label && <span className="font-medium">{label}: </span>}
        {c.subject}
      </p>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
        <a href={`${repoUrl}/commit/${c.sha}`} target="_blank" rel="noreferrer" className="ref ref--person">
          {c.shortSha}
        </a>
        <span className="text-ink-2">{c.author}</span>
        <time className="measured text-cool">{c.date}</time>
        {c.linesChanged !== null && <span className="measured text-muted">±{c.linesChanged}</span>}
        {c.prNumbers.map((n) => (
          <a key={n} href={`${repoUrl}/pull/${n}`} target="_blank" rel="noreferrer" className="ref ref--person">
            #{n}
          </a>
        ))}
      </p>
    </li>
  );
}

export function WhyPanel({ repoId, repoUrl }: { repoId: string; repoUrl: string }) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [path, setPath] = useState("");
  const [symbols, setSymbols] = useState<SymbolEntry[]>([]);
  const [symbol, setSymbol] = useState("");
  const [result, setResult] = useState<WhyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.files(repoId).then(setFiles, () => setFiles([]));
  }, [repoId]);

  const knownFile = files.some((f) => f.path === path);
  useEffect(() => {
    setSymbol("");
    if (!knownFile) return setSymbols([]);
    api.symbols(repoId, path).then(setSymbols, () => setSymbols([]));
  }, [repoId, path, knownFile]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.why(repoId, { path: path.trim(), ...(symbol ? { symbol } : {}) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="space-y-6" aria-labelledby="why-heading">
      <h2 id="why-heading">Why does this exist?</h2>
      <form onSubmit={onSubmit} className="grid max-w-5xl items-end gap-2 sm:grid-cols-[minmax(0,1fr)_14rem_auto]">
        <div className="min-w-0">
          <label htmlFor="why-path" className="label">
            File path
          </label>
          <input
            id="why-path"
            list="why-files"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="src/package/module.py"
            autoComplete="off"
            className="field measured"
          />
          <datalist id="why-files">
            {files.map((f) => (
              <option key={f.path} value={f.path} />
            ))}
          </datalist>
        </div>
        <div className="min-w-0">
          <label htmlFor="why-symbol" className="label">
            Symbol (optional)
          </label>
          <select id="why-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={symbols.length === 0} className="field">
            <option value="">Whole file</option>
            {symbols.map((s) => (
              <option key={`${s.qualifiedName}:${s.startLine}`} value={s.qualifiedName}>
                {s.kind} {s.qualifiedName}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={loading || !path.trim()} aria-busy={loading || undefined} className="btn btn--primary">
          {loading ? "Digging…" : "Explain"}
        </button>
      </form>
      {error && <p className="text-sm text-bad">{error}</p>}
      {loading && <div className="skeleton h-64 motion-safe:animate-pulse" aria-busy="true" aria-label="Reading the history" />}

      {result && (
        <article className="panel space-y-6 p-6">
          <header className="space-y-4">
            <h3 className="break-all text-xl">{result.target.symbol ? `${result.target.path} · ${result.target.symbol}` : result.target.path}</h3>
            <dl className="flex flex-wrap gap-x-8 gap-y-2">
              <div>
                <dt className="text-xs text-muted">History</dt>
                <dd className="measured text-ink">
                  {result.totalCommits} commit{result.totalCommits === 1 ? "" : "s"}
                </dd>
              </div>
              {result.target.startLine && (
                <div>
                  <dt className="text-xs text-muted">Lines</dt>
                  <dd className="measured text-ink">
                    {result.target.startLine} to {result.target.endLine}
                  </dd>
                </div>
              )}
            </dl>
          </header>

          <CitedText text={result.answer} repoUrl={repoUrl} />

          <div className="grid gap-8 border-t border-rule pt-5 text-sm lg:grid-cols-2">
            <div className="space-y-3">
              <h4 className="font-medium text-ink">History</h4>
              <ul className="space-y-4 border-l border-rule-2 pl-4">
                <CommitRow label="Introduced" c={result.introduced} repoUrl={repoUrl} />
                {result.majorChanges.map((c) => (
                  <CommitRow key={c.sha} c={c} repoUrl={repoUrl} />
                ))}
                {result.latest.sha !== result.introduced.sha && <CommitRow label="Latest" c={result.latest} repoUrl={repoUrl} />}
              </ul>
            </div>
            <div className="space-y-3">
              <h4 className="font-medium text-ink">Where today&apos;s lines come from</h4>
              <ul className="space-y-3">
                {result.blame.map((b) => (
                  <li key={b.sha} className="space-y-1.5">
                    <div className="flex justify-between gap-3">
                      <span className="min-w-0 truncate text-ink-2">
                        <a href={`${repoUrl}/commit/${b.sha}`} target="_blank" rel="noreferrer" className="ref ref--person">
                          {b.shortSha}
                        </a>{" "}
                        {b.summary}
                      </span>
                      <span className="measured shrink-0 text-muted">{b.percent}%</span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-rule">
                      <div className="h-full origin-left rounded-full bg-accent" style={{ transform: `scaleX(${Math.min(100, b.percent) / 100})` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {result.pullRequests.length > 0 && (
            <div className="space-y-3 border-t border-rule pt-5 text-sm">
              <h4 className="font-medium text-ink">Related pull requests</h4>
              <ul className="space-y-3">
                {result.pullRequests.map((p) => (
                  <li key={p.number} className="space-y-0.5">
                    <p className="flex flex-wrap items-baseline gap-x-3">
                      <a href={`${repoUrl}/pull/${p.number}`} target="_blank" rel="noreferrer" className="ref ref--person">
                        #{p.number}
                      </a>
                      <span className="font-medium text-ink">{p.title}</span>
                      {p.mergedAt && (
                        <span className="text-xs text-muted">
                          merged <time className="measured text-cool">{p.mergedAt}</time>
                        </span>
                      )}
                    </p>
                    {p.excerpt && <p className="max-w-[72ch] text-ink-2">{p.excerpt}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.fallback && <p className="text-xs text-muted">Written directly from the git evidence (no usable model output).</p>}
        </article>
      )}
    </section>
  );
}
