"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AppConfigDto, BugReport, FixAttemptDto, FixRunDto, TraceEvent, TraceRunDto } from "@archaeo/shared";
import { api } from "@/lib/api";
import { CitedLine } from "./cited-text";
import { useCodeViewer } from "./code-viewer";
import { DiffView } from "./diff-view";

const CONFIDENCE_TONES: Record<BugReport["confidence"], "ok" | "accent" | undefined> = {
  low: undefined,
  medium: "accent",
  high: "ok",
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
    <article className="panel space-y-6 p-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-xl">Case file</h3>
          <span className="chip" data-tone={CONFIDENCE_TONES[report.confidence]}>
            {report.confidence} confidence
          </span>
        </div>
        {report.fallback && <p className="text-xs text-muted">Ranked from evidence (no usable model output).</p>}
        {report.issue && (
          <a href={report.issue.url} target="_blank" rel="noreferrer" className="link block font-medium text-ink">
            #{report.issue.number} {report.issue.title}
          </a>
        )}
        {report.exception && <p className="measured break-words rounded-pill bg-bad-soft px-3 py-2 text-sm text-bad">{report.exception}</p>}
      </header>

      <section className="space-y-1.5">
        <h4 className="text-sm font-medium text-ink">Hypothesis</h4>
        <p className="max-w-[72ch] leading-relaxed text-ink-2">
          <CitedLine text={report.hypothesis} repoUrl={repoUrl} />
        </p>
      </section>

      {report.evidence.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-sm font-medium text-ink">Evidence</h4>
          <ul className="space-y-2 text-sm">
            {report.evidence.map((e, i) => (
              <li key={i} className="grid gap-0.5 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] sm:gap-4">
                <button type="button" onClick={() => open(e.ref)} className="ref ref--instrument truncate">
                  {refText(e.ref)}
                </button>
                <span className="text-ink-2">{e.why}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h4 className="text-sm font-medium text-ink">Suspects</h4>
        <ol className="space-y-3 text-sm">
          {report.suspects.map((s, i) => (
            <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5">
              <span className="measured text-muted">{i + 1}</span>
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <button type="button" onClick={() => open(s)} className="ref ref--instrument flex min-w-0 gap-3">
                    <span className="truncate">{s.symbol ?? refText(s)}</span>
                    {s.symbol && <span className="truncate text-muted">{refText(s)}</span>}
                  </button>
                  <span className="measured shrink-0 text-muted">{s.score}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-rule">
                  <div
                    className="h-full origin-left rounded-full bg-cool"
                    style={{ transform: `scaleX(${Math.min(100, (s.score / (report.suspects[0]?.score || 1)) * 100) / 100})` }}
                  />
                </div>
                <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                  {s.reasons.map((r, j) => (
                    <li key={j}>{r}</li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
          {report.suspects.length === 0 && <li className="text-muted">No suspects found.</li>}
        </ol>
      </section>

      <div className="grid gap-6 border-t border-rule pt-5 text-sm sm:grid-cols-2">
        {report.filesToChange.length > 0 && (
          <section className="space-y-1.5">
            <h4 className="font-medium text-ink">Files to change</h4>
            <ul className="measured space-y-0.5 text-xs text-ink-2">
              {report.filesToChange.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </section>
        )}
        {repoFrames.length > 0 && (
          <section className="space-y-1.5">
            <h4 className="font-medium text-ink">Stack frames in this repo</h4>
            <ul className="space-y-0.5 text-xs">
              {repoFrames.map((f, i) => (
                <li key={i}>
                  <button type="button" onClick={() => open({ path: f.path!, startLine: f.line, endLine: f.line })} className="ref ref--instrument">
                    {f.path}:{f.line}
                  </button>
                  {f.func && <span className="text-muted"> in {f.func}</span>}
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
  return (
    <li className={`panel space-y-4 p-5 ${offered ? "border-ok/60" : ""}`}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-ink">Attempt {a.attempt}</span>
        <span className="chip" data-tone={a.passed ? "ok" : "bad"}>
          {status}
        </span>
        {a.regressionTest && (
          <span className="chip" data-tone="cool">
            {a.reproduced === true ? "regression test reproduces the bug" : a.reproduced === false ? "test passes without the fix" : "adds a test"}
          </span>
        )}
        {a.durationMs !== null && <span className="measured text-xs text-muted">{Math.round(a.durationMs / 1000)} s</span>}
      </div>
      {a.applyError && <p className="measured break-words rounded-pill bg-bad-soft px-3 py-2 text-xs text-bad">{a.applyError}</p>}
      {a.testSummary && <p className="text-sm text-ink-2">{a.testSummary}</p>}
      {a.newFailures.length > 0 && (
        <p className="break-words text-xs text-bad">
          New failures: <span className="measured">{a.newFailures.slice(0, 8).join(", ")}</span>
          {a.newFailures.length > 8 && ` and ${a.newFailures.length - 8} more`}
        </p>
      )}
      <details className="group text-sm" open={offered}>
        <summary className="w-fit cursor-pointer text-ink-2 transition-colors duration-200 hover:text-ink">Patch</summary>
        <div className="mt-2">
          <DiffView diff={a.patch} />
        </div>
      </details>
      {a.testOutputTail && (
        <details className="text-sm">
          <summary className="w-fit cursor-pointer text-ink-2 transition-colors duration-200 hover:text-ink">Test output</summary>
          <pre className="measured mt-2 max-h-72 overflow-auto rounded-pill bg-paper-3 p-3 text-xs leading-5 text-ink-2">{a.testOutputTail}</pre>
        </details>
      )}
      {offered && (
        <div className="space-y-2 border-t border-rule pt-4">
          {a.prUrl ? (
            <p className="text-sm text-ink-2">
              Pull request opened:{" "}
              <a href={a.prUrl} target="_blank" rel="noreferrer" className="link measured text-ok">
                {a.prUrl}
              </a>
            </p>
          ) : (
            <>
              <button type="button" onClick={approve} disabled={busy || !config?.publishing.enabled} aria-busy={busy || undefined} className="btn btn--primary">
                {busy ? "Publishing…" : "Approve and open pull request"}
              </button>
              <p className="max-w-[72ch] text-xs text-muted">
                {config?.publicDemo
                  ? "Publishing is turned off in this public demo. The patch above passed the full test suite in the sandbox."
                  : config?.publishing.enabled
                    ? `Nothing is pushed until you approve. The pull request opens ${config.publishing.target === "upstream" ? `against ${repoName}` : "inside your fork"}.`
                    : "Publishing is off: set GITHUB_TOKEN (allowed to fork and open pull requests) and restart the API."}
              </p>
            </>
          )}
          {error && <p className="text-sm text-bad">{error}</p>}
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

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!run)
    return (
      <p className="text-sm text-muted motion-safe:animate-pulse" role="status">
        Starting the fixer…
      </p>
    );
  return (
    <section className="space-y-4" aria-label="Fix attempts">
      <div className="space-y-1.5">
        <h3 className="text-xl">Fix</h3>
        <p className="flex flex-wrap items-baseline gap-x-4 text-sm" role="status">
          <span className={running ? "text-ink-2 motion-safe:animate-pulse" : run.offeredAttemptId ? "text-ok" : "text-ink-2"}>{run.phase}</span>
          {run.baseSha && <span className="measured text-xs text-muted">base {run.baseSha.slice(0, 7)}</span>}
        </p>
        {run.baseline && <p className="text-xs text-muted">Baseline tests: {run.baseline.summary}</p>}
        {run.error && <p className="text-sm text-bad">{run.error}</p>}
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
    <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]" aria-labelledby="fix-heading">
      <div className="min-w-0 space-y-6">
        <h2 id="fix-heading">Trace and fix a bug</h2>
        <form onSubmit={onTrace} className="max-w-4xl space-y-4">
          <div>
            <label htmlFor="bug-text" className="label">
              Error, stack trace or bug description
            </label>
            <textarea
              id="bug-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder="Paste an error or stack trace, or describe what goes wrong…"
              className="field measured"
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label htmlFor="issue-url" className="label">
                GitHub issue URL (optional)
              </label>
              <input id="issue-url" value={issueUrl} onChange={(e) => setIssueUrl(e.target.value)} placeholder={`${repoUrl}/issues/123`} autoComplete="off" className="field measured" />
            </div>
            <button type="submit" disabled={tracing || (text.trim().length < 10 && !issueUrl.trim())} aria-busy={tracing || undefined} className="btn btn--primary">
              {tracing ? "Tracing…" : "Trace bug"}
            </button>
          </div>
        </form>
        {error && <p className="text-sm text-bad">{error}</p>}
        {(tracing || activity.length > 0) && !current && (
          <ul className="log max-w-4xl" aria-label="Tool calls">
            {activity.map((a) => (
              <li key={a.id}>
                <span className={a.done ? "text-muted" : "text-accent"}>{a.done ? "done" : "running"}</span>
                <span className="truncate text-ink-2">{a.label}</span>
              </li>
            ))}
            {tracing && (
              <li role="status">
                <span className="text-accent">running</span>
                <span className="text-ink-2 motion-safe:animate-pulse">Ranking suspects and investigating…</span>
              </li>
            )}
          </ul>
        )}

        {current?.report && (
          <>
            <CaseFile report={current.report} repoUrl={repoUrl} />
            {current.fixRunId ? (
              <FixRunView key={current.fixRunId} repoId={repoId} repoName={repoName} runId={current.fixRunId} config={config} />
            ) : (
              <div className="flex flex-wrap items-center gap-4">
                <button type="button" onClick={startFix} disabled={!current.report.filesToChange.length} className="btn btn--primary">
                  Generate a tested fix
                </button>
                <p className="max-w-[60ch] text-xs text-muted">
                  Runs up to 3 patch attempts against the full test suite in an offline {config?.sandbox.provider ?? "docker"} sandbox. Nothing is pushed.
                </p>
              </div>
            )}
          </>
        )}
        {current && !current.report && current.error && <p className="text-sm text-bad">Trace failed: {current.error}</p>}
      </div>

      <aside className="min-w-0 space-y-3 lg:border-l lg:border-rule lg:pl-6">
        <h3 className="text-sm font-medium tracking-normal text-muted">Recent cases</h3>
        {cases.length === 0 && <p className="text-sm text-muted">No cases yet.</p>}
        <ul className="space-y-1">
          {cases.map((c) => (
            <li
              key={c.id}
              className={`relative rounded-pill px-3 pb-2 transition-colors duration-200 ${
                current?.id === c.id ? "bg-paper-2 shadow-[inset_2px_0_0_var(--color-accent)]" : "hover:bg-paper-hover"
              }`}
            >
              <button
                type="button"
                onClick={() => setCurrent(c)}
                aria-current={current?.id === c.id || undefined}
                title={caseTitle(c)}
                className="flex min-h-8 w-full cursor-pointer items-center text-left text-sm text-ink after:absolute after:inset-0 after:content-['']"
              >
                <span className="truncate">{caseTitle(c)}</span>
              </button>
              <p className="flex gap-3 text-xs text-muted">
                <time className="measured">{new Date(c.createdAt).toLocaleString()}</time>
                {c.fixRunId && <span>fix run</span>}
              </p>
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}
