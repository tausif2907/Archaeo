"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AppConfigDto, BugReport, FixAttemptDto, FixRunDto, TraceEvent, TraceRunDto } from "@archaeo/shared";
import { api } from "@/lib/api";
import { CitedLine } from "./cited-text";
import { useCodeViewer } from "./code-viewer";
import { DiffView } from "./diff-view";

const CONFIDENCE_STYLES: Record<BugReport["confidence"], string> = {
  low: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  high: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
};

function refText(r: { path: string; startLine: number; endLine: number }) {
  return r.startLine === r.endLine ? `${r.path}:${r.startLine}` : `${r.path}:${r.startLine}-${r.endLine}`;
}

function caseTitle(c: TraceRunDto): string {
  return c.report?.issue?.title ?? c.report?.exception ?? c.input.text.trim().split("\n")[0]?.slice(0, 80) ?? c.input.issueUrl ?? "Bug";
}

function CaseFile({ report, repoUrl }: { report: BugReport; repoUrl: string }) {
  const viewer = useCodeViewer();
  const open = (r: { path: string; startLine: number; endLine: number }) => viewer?.open(r);
  const repoFrames = report.frames.filter((f) => f.path);
  return (
    <article className="space-y-5 rounded-xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-stone-500">Case file</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CONFIDENCE_STYLES[report.confidence]}`}>{report.confidence} confidence</span>
          {report.fallback && <span className="text-xs text-stone-500">ranked from evidence (no usable model output)</span>}
        </div>
        {report.issue && (
          <a href={report.issue.url} target="_blank" rel="noreferrer" className="block font-medium hover:underline">
            #{report.issue.number} {report.issue.title}
          </a>
        )}
        {report.exception && <p className="break-words font-mono text-sm text-red-700 dark:text-red-400">{report.exception}</p>}
      </header>

      <section>
        <h3 className="mb-1 text-sm font-semibold">Hypothesis</h3>
        <p className="leading-relaxed">
          <CitedLine text={report.hypothesis} repoUrl={repoUrl} />
        </p>
      </section>

      {report.evidence.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Evidence</h3>
          <ul className="space-y-1.5 text-sm">
            {report.evidence.map((e, i) => (
              <li key={i} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                <button type="button" onClick={() => open(e.ref)} className="shrink-0 text-left font-mono text-sky-800 hover:underline dark:text-sky-300">
                  {refText(e.ref)}
                </button>
                <span className="text-stone-700 dark:text-stone-300">{e.why}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-sm font-semibold">Suspects</h3>
        <ol className="space-y-2 text-sm">
          {report.suspects.map((s, i) => (
            <li key={i} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <button type="button" onClick={() => open(s)} className="min-w-0 truncate text-left font-mono text-sky-800 hover:underline dark:text-sky-300">
                  {i + 1}. {s.symbol ?? refText(s)}
                  <span className="text-stone-500"> · {refText(s)}</span>
                </button>
                <span className="shrink-0 tabular-nums text-stone-500">{s.score}</span>
              </div>
              <div className="h-1 rounded-full bg-stone-200 dark:bg-stone-800">
                <div className="h-full rounded-full bg-amber-400" style={{ width: `${Math.min(100, (s.score / (report.suspects[0]?.score || 1)) * 100)}%` }} />
              </div>
              <p className="text-xs text-stone-500">{s.reasons.join(" · ")}</p>
            </li>
          ))}
          {report.suspects.length === 0 && <li className="text-stone-500">No suspects found.</li>}
        </ol>
      </section>

      <div className="grid gap-4 text-sm sm:grid-cols-2">
        {report.filesToChange.length > 0 && (
          <section>
            <h3 className="mb-1 font-semibold">Files to change</h3>
            <ul className="font-mono text-xs">
              {report.filesToChange.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </section>
        )}
        {repoFrames.length > 0 && (
          <section>
            <h3 className="mb-1 font-semibold">Stack frames in this repo</h3>
            <ul className="space-y-0.5 font-mono text-xs">
              {repoFrames.map((f, i) => (
                <li key={i}>
                  <button type="button" onClick={() => open({ path: f.path!, startLine: f.line, endLine: f.line })} className="text-sky-800 hover:underline dark:text-sky-300">
                    {f.path}:{f.line}
                  </button>
                  {f.func && <span className="text-stone-500"> in {f.func}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </article>
  );
}

function Attempt({ a, offered, config, repoId, repoName, onPublished }: { a: FixAttemptDto; offered: boolean; config: AppConfigDto | null; repoId: string; repoName: string; onPublished: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    const where = config?.publishing.target === "upstream" ? `open a pull request against ${repoName}` : `open a pull request inside your fork of ${repoName}`;
    if (!window.confirm(`Approve this patch?\n\nArchaeo will fork ${repoName} to your GitHub account (if needed), push a branch with this commit, and ${where}.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.approve(repoId, a.id);
      onPublished();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const status = a.passed ? "Passed" : a.applied ? "Tests failed" : "Not applied";
  const statusCls = a.passed ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
  return (
    <li className={`space-y-3 rounded-xl border p-4 ${offered ? "border-emerald-400 dark:border-emerald-700" : "border-stone-200 dark:border-stone-800"} bg-white dark:bg-stone-900`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Attempt {a.attempt}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusCls}`}>{status}</span>
        {a.regressionTest && (
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">
            {a.reproduced === true ? "regression test reproduces the bug" : a.reproduced === false ? "test passes without the fix" : "adds a test"}
          </span>
        )}
        {a.durationMs !== null && <span className="text-xs text-stone-500">{Math.round(a.durationMs / 1000)} s</span>}
      </div>
      {a.applyError && <p className="break-words font-mono text-xs text-red-700 dark:text-red-400">{a.applyError}</p>}
      {a.testSummary && <p className="text-sm text-stone-700 dark:text-stone-300">{a.testSummary}</p>}
      {a.newFailures.length > 0 && (
        <p className="break-words text-xs text-red-700 dark:text-red-400">
          New failures: <span className="font-mono">{a.newFailures.slice(0, 8).join(", ")}</span>
          {a.newFailures.length > 8 && ` and ${a.newFailures.length - 8} more`}
        </p>
      )}
      <details className="text-sm" open={offered}>
        <summary className="cursor-pointer text-stone-600 dark:text-stone-400">Patch</summary>
        <div className="mt-2">
          <DiffView diff={a.patch} />
        </div>
      </details>
      {a.testOutputTail && (
        <details className="text-sm">
          <summary className="cursor-pointer text-stone-600 dark:text-stone-400">Test output</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-stone-950 p-3 font-mono text-xs leading-5 text-stone-200">{a.testOutputTail}</pre>
        </details>
      )}
      {offered && (
        <div className="space-y-2 border-t border-stone-200 pt-3 dark:border-stone-800">
          {a.prUrl ? (
            <p className="text-sm">
              Pull request opened:{" "}
              <a href={a.prUrl} target="_blank" rel="noreferrer" className="font-medium text-emerald-800 hover:underline dark:text-emerald-300">
                {a.prUrl}
              </a>
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={approve}
                disabled={busy || !config?.publishing.enabled}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-emerald-600"
              >
                {busy ? "Publishing…" : "Approve and open pull request"}
              </button>
              <p className="text-xs text-stone-500">
                {config?.publicDemo
                  ? "Publishing is turned off in this public demo. The patch above passed the full test suite in the sandbox."
                  : config?.publishing.enabled
                    ? `Nothing is pushed until you approve. The pull request opens ${config.publishing.target === "upstream" ? `against ${repoName}` : "inside your fork"}.`
                    : "Publishing is off: set GITHUB_TOKEN (allowed to fork and open pull requests) and restart the API."}
              </p>
            </>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </li>
  );
}

function FixRunView({ repoId, repoName, runId, config }: { repoId: string; repoName: string; runId: string; config: AppConfigDto | null }) {
  const [run, setRun] = useState<FixRunDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.run<FixRunDto>(repoId, runId).then(setRun, (err: Error) => setError(err.message)), [repoId, runId]);
  const running = !run || run.status === "running";

  useEffect(() => {
    void load();
    if (!running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load, running]);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!run) return <p className="animate-pulse text-sm text-stone-500">Starting the fixer…</p>;
  return (
    <section className="space-y-4" aria-label="Fix attempts">
      <div className="space-y-1">
        <h3 className="font-semibold">Fix</h3>
        <p className={`text-sm ${running ? "animate-pulse text-stone-600 dark:text-stone-400" : run.offeredAttemptId ? "text-emerald-700 dark:text-emerald-400" : "text-stone-700 dark:text-stone-300"}`}>
          {run.phase}
          {run.baseSha && ` · base ${run.baseSha.slice(0, 7)}`}
        </p>
        {run.baseline && <p className="text-xs text-stone-500">Baseline tests: {run.baseline.summary}</p>}
        {run.error && <p className="text-sm text-red-600 dark:text-red-400">{run.error}</p>}
      </div>
      <ol className="space-y-3">
        {run.attempts.map((a) => (
          <Attempt key={a.id} a={a} offered={a.id === run.offeredAttemptId} config={config} repoId={repoId} repoName={repoName} onPublished={() => void load()} />
        ))}
      </ol>
    </section>
  );
}

export function FixPanel({ repoId, repoUrl, repoName }: { repoId: string; repoUrl: string; repoName: string }) {
  const [text, setText] = useState("");
  const [issueUrl, setIssueUrl] = useState("");
  const [config, setConfig] = useState<AppConfigDto | null>(null);
  const [cases, setCases] = useState<TraceRunDto[]>([]);
  const [current, setCurrent] = useState<TraceRunDto | null>(null);
  const [activity, setActivity] = useState<{ id: string; label: string; done: boolean }[]>([]);
  const [tracing, setTracing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const refreshCases = useCallback(() => api.cases(repoId).then(setCases, () => setCases([])), [repoId]);
  useEffect(() => {
    void refreshCases();
    api.config().then(setConfig, () => setConfig(null));
  }, [refreshCases]);

  async function onTrace(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setActivity([]);
    setCurrent(null);
    setTracing(true);
    abort.current = new AbortController();
    let runId: string | null = null;
    const onEvent = (ev: TraceEvent) => {
      if (ev.type === "run") runId = ev.runId;
      if (ev.type === "tool_call") setActivity((a) => [...a, { id: ev.id, label: `${ev.name} ${JSON.stringify(ev.args).slice(0, 80)}`, done: false }]);
      if (ev.type === "tool_result") setActivity((a) => a.map((x) => (x.id === ev.id ? { ...x, label: ev.summary, done: true } : x)));
      if (ev.type === "error") setError(ev.message);
    };
    try {
      await api.trace(repoId, { text, ...(issueUrl.trim() ? { issueUrl: issueUrl.trim() } : {}) }, onEvent, abort.current.signal);
      if (runId) setCurrent(await api.run<TraceRunDto>(repoId, runId));
      void refreshCases();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTracing(false);
    }
  }

  async function startFix() {
    if (!current) return;
    setError(null);
    try {
      const run = await api.startFix(repoId, current.id);
      setCurrent({ ...current, fixRunId: run.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="grid gap-6 lg:grid-cols-[1fr_260px]" aria-labelledby="fix-heading">
      <div className="min-w-0 space-y-5">
        <h2 id="fix-heading" className="text-lg font-semibold">
          Trace and fix a bug
        </h2>
        <form onSubmit={onTrace} className="space-y-2">
          <label htmlFor="bug-text" className="sr-only">
            Error, stack trace or bug description
          </label>
          <textarea
            id="bug-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="Paste an error or stack trace, or describe what goes wrong…"
            className="w-full resize-y rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-900"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="issue-url" className="sr-only">
              GitHub issue URL (optional)
            </label>
            <input
              id="issue-url"
              value={issueUrl}
              onChange={(e) => setIssueUrl(e.target.value)}
              placeholder={`or a GitHub issue URL, e.g. ${repoUrl}/issues/123`}
              className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-900"
            />
            <button
              type="submit"
              disabled={tracing || (text.trim().length < 10 && !issueUrl.trim())}
              className="rounded-lg bg-stone-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
            >
              {tracing ? "Tracing…" : "Trace bug"}
            </button>
          </div>
        </form>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {(tracing || activity.length > 0) && !current && (
          <ul className="space-y-1 text-xs text-stone-500">
            {activity.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.done ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`} />
                <span className="truncate">{a.label}</span>
              </li>
            ))}
            {tracing && <li className="animate-pulse">Ranking suspects and investigating…</li>}
          </ul>
        )}

        {current?.report && (
          <>
            <CaseFile report={current.report} repoUrl={repoUrl} />
            {current.fixRunId ? (
              <FixRunView key={current.fixRunId} repoId={repoId} repoName={repoName} runId={current.fixRunId} config={config} />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={startFix} disabled={!current.report.filesToChange.length} className="rounded-lg bg-stone-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900">
                  Generate a tested fix
                </button>
                <p className="text-xs text-stone-500">Runs up to 3 patch attempts against the full test suite in an offline {config?.sandbox.provider ?? "docker"} sandbox. Nothing is pushed.</p>
              </div>
            )}
          </>
        )}
        {current && !current.report && current.error && <p className="text-sm text-red-600 dark:text-red-400">Trace failed: {current.error}</p>}
      </div>

      <aside className="space-y-2">
        <h3 className="text-sm font-medium text-stone-500">Recent cases</h3>
        {cases.length === 0 && <p className="text-xs text-stone-500">No cases yet.</p>}
        <ul className="space-y-1">
          {cases.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setCurrent(c)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800 ${current?.id === c.id ? "bg-stone-100 dark:bg-stone-800" : ""}`}
              >
                <span className="line-clamp-2">{caseTitle(c)}</span>
                <span className="text-xs text-stone-500">
                  {new Date(c.createdAt).toLocaleString()} {c.fixRunId ? "· fix run" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}
