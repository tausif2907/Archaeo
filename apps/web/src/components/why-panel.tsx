"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { FileEntry, SymbolEntry, WhyCommit, WhyResult } from "@archaeo/shared";
import { api } from "@/lib/api";
import { CitedText } from "./cited-text";

function CommitRow({ label, c, repoUrl }: { label?: string; c: WhyCommit; repoUrl: string }) {
  return (
    <li className="flex gap-2">
      <a href={`${repoUrl}/commit/${c.sha}`} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-amber-800 hover:underline dark:text-amber-300">
        {c.shortSha}
      </a>
      <span className="min-w-0">
        {label && <span className="font-medium">{label}: </span>}
        {c.subject}
        <span className="text-stone-500">
          {" "}
          · {c.author}, {c.date}
          {c.linesChanged !== null && ` · ±${c.linesChanged}`}
        </span>
        {c.prNumbers.map((n) => (
          <a key={n} href={`${repoUrl}/pull/${n}`} target="_blank" rel="noreferrer" className="ml-1 font-mono text-amber-800 hover:underline dark:text-amber-300">
            #{n}
          </a>
        ))}
      </span>
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
    <section className="space-y-4" aria-labelledby="why-heading">
      <h2 id="why-heading" className="text-lg font-semibold">
        Why does this exist?
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="why-path" className="sr-only">
          File path
        </label>
        <input
          id="why-path"
          list="why-files"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="src/package/module.py"
          className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-900"
        />
        <datalist id="why-files">
          {files.map((f) => (
            <option key={f.path} value={f.path} />
          ))}
        </datalist>
        <label htmlFor="why-symbol" className="sr-only">
          Symbol (optional)
        </label>
        <select
          id="why-symbol"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          disabled={symbols.length === 0}
          className="min-w-0 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm disabled:opacity-50 sm:max-w-56 dark:border-stone-700 dark:bg-stone-900"
        >
          <option value="">Whole file</option>
          {symbols.map((s) => (
            <option key={`${s.qualifiedName}:${s.startLine}`} value={s.qualifiedName}>
              {s.kind} {s.qualifiedName}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={loading || !path.trim()}
          className="rounded-lg bg-stone-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
        >
          {loading ? "Digging…" : "Explain"}
        </button>
      </form>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <article className="space-y-4 rounded-xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
          <header>
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
              {result.totalCommits} commit{result.totalCommits === 1 ? "" : "s"} of history
            </p>
            <h3 className="break-all font-mono text-base font-semibold">
              {result.target.symbol ? `${result.target.path} · ${result.target.symbol}` : result.target.path}
              {result.target.startLine && <span className="font-normal text-stone-500"> (lines {result.target.startLine}–{result.target.endLine})</span>}
            </h3>
          </header>

          <CitedText text={result.answer} repoUrl={repoUrl} />

          <div className="grid gap-5 border-t border-stone-200 pt-4 text-sm lg:grid-cols-2 dark:border-stone-800">
            <div className="space-y-2">
              <h4 className="font-medium">History</h4>
              <ul className="space-y-1.5">
                <CommitRow label="Introduced" c={result.introduced} repoUrl={repoUrl} />
                {result.majorChanges.map((c) => (
                  <CommitRow key={c.sha} c={c} repoUrl={repoUrl} />
                ))}
                {result.latest.sha !== result.introduced.sha && <CommitRow label="Latest" c={result.latest} repoUrl={repoUrl} />}
              </ul>
            </div>
            <div className="space-y-2">
              <h4 className="font-medium">Where today&apos;s lines come from</h4>
              <ul className="space-y-2">
                {result.blame.map((b) => (
                  <li key={b.sha} className="space-y-1">
                    <div className="flex justify-between gap-2">
                      <span className="min-w-0 truncate">
                        <a href={`${repoUrl}/commit/${b.sha}`} target="_blank" rel="noreferrer" className="font-mono text-amber-800 hover:underline dark:text-amber-300">
                          {b.shortSha}
                        </a>{" "}
                        {b.summary}
                      </span>
                      <span className="shrink-0 tabular-nums text-stone-500">{b.percent}%</span>
                    </div>
                    <div className="h-1 rounded-full bg-stone-200 dark:bg-stone-800">
                      <div className="h-full rounded-full bg-amber-400" style={{ width: `${b.percent}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {result.pullRequests.length > 0 && (
            <div className="space-y-2 border-t border-stone-200 pt-4 text-sm dark:border-stone-800">
              <h4 className="font-medium">Related pull requests</h4>
              <ul className="space-y-2">
                {result.pullRequests.map((p) => (
                  <li key={p.number}>
                    <a href={`${repoUrl}/pull/${p.number}`} target="_blank" rel="noreferrer" className="font-mono text-amber-800 hover:underline dark:text-amber-300">
                      #{p.number}
                    </a>{" "}
                    <span className="font-medium">{p.title}</span>
                    {p.mergedAt && <span className="text-stone-500"> · merged {p.mergedAt}</span>}
                    {p.excerpt && <p className="mt-0.5 text-stone-600 dark:text-stone-400">{p.excerpt}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.fallback && <p className="text-xs text-stone-500">Written directly from the git evidence (no usable model output).</p>}
        </article>
      )}
    </section>
  );
}
