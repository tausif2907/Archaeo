"use client";

import { useRef, useState, type FormEvent } from "react";
import type { AgentEvent, AskResult } from "@archaeo/shared";
import { api } from "@/lib/api";
import { CitedText } from "./cited-text";

interface Turn {
  question: string;
  activity: { id: string; label: string; done: boolean }[];
  notes: string[];
  result: AskResult | null;
  error: string | null;
  running: boolean;
}

const SUGGESTIONS = ["What are the main modules and how do they fit together?", "Where is the program's entry point?", "How are errors reported to the user?"];

const TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  search_code: (a) => `Searching code for "${String(a.query ?? "")}"`,
  read_file: (a) => `Reading ${String(a.path ?? "")}${a.startLine ? `:${String(a.startLine)}-${String(a.endLine ?? "")}` : ""}`,
  get_callers: (a) => `Finding callers of ${String(a.symbol ?? "")}`,
  get_callees: (a) => `Finding what ${String(a.symbol ?? "")} calls`,
  git_blame: (a) => `Blaming ${String(a.path ?? "")}:${String(a.line ?? "")}`,
  list_dir: (a) => `Listing ${String(a.path || "/")}`,
};

export function AskPanel({ repoId, repoUrl }: { repoId: string; repoUrl: string }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const abort = useRef<AbortController | null>(null);
  const running = turns.some((t) => t.running);

  const update = (i: number, fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t, j) => (j === i ? fn(t) : t)));

  async function submit(q: string) {
    const text = q.trim();
    if (text.length < 3 || running) return;
    setQuestion("");
    const index = turns.length;
    setTurns((ts) => [...ts, { question: text, activity: [], notes: [], result: null, error: null, running: true }]);
    abort.current = new AbortController();

    const onEvent = (e: AgentEvent) => {
      switch (e.type) {
        case "tool_call":
          update(index, (t) => ({ ...t, activity: [...t.activity, { id: e.id, label: (TOOL_LABELS[e.name] ?? ((a) => `${e.name} ${JSON.stringify(a)}`))(e.args), done: false }] }));
          break;
        case "tool_result":
          update(index, (t) => ({ ...t, activity: t.activity.map((a) => (a.id === e.id ? { ...a, label: e.summary, done: true } : a)) }));
          break;
        case "thinking":
          update(index, (t) => ({ ...t, notes: [...t.notes, e.text] }));
          break;
        case "limit":
          update(index, (t) => ({ ...t, notes: [...t.notes, e.message] }));
          break;
        case "answer":
          update(index, (t) => ({ ...t, result: e.result }));
          break;
        case "error":
          update(index, (t) => ({ ...t, error: e.message }));
          break;
      }
    };
    try {
      await api.ask(repoId, text, onEvent, abort.current.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      update(index, (t) => ({ ...t, error: message.includes("abort") ? "Stopped." : message }));
    } finally {
      update(index, (t) => ({ ...t, running: false }));
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(question);
  }

  return (
    <section className="space-y-6" aria-labelledby="ask-heading">
      <h2 id="ask-heading">Ask the codebase</h2>

      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => void submit(s)} className="btn font-normal text-ink-2">
              {s}
            </button>
          ))}
        </div>
      )}

      {turns.length > 0 && (
        <ol className="space-y-8">
          {turns.map((t, i) => (
            <li key={i} className="space-y-4 border-l border-rule-2 pl-5">
              <p className="max-w-[72ch] text-md font-medium text-ink">{t.question}</p>
              {t.activity.length > 0 && (
                <ul className="log max-w-3xl" aria-label="Tool calls">
                  {t.activity.map((a) => (
                    <li key={a.id}>
                      <span className={a.done ? "text-muted" : "text-accent"}>{a.done ? "done" : "running"}</span>
                      <span className="truncate text-ink-2">{a.label}</span>
                    </li>
                  ))}
                </ul>
              )}
              {t.notes.map((n, j) => (
                <p key={j} className="max-w-[72ch] text-sm text-muted">
                  {n}
                </p>
              ))}
              {t.running && !t.result && (
                <p className="text-sm text-muted motion-safe:animate-pulse" role="status">
                  Investigating…
                </p>
              )}
              {t.result && <CitedText text={t.result.answer} repoUrl={repoUrl} />}
              {t.result && (
                <div className="space-y-1 text-xs">
                  <dl className="flex flex-wrap gap-x-6 gap-y-1">
                    <div className="flex gap-1.5">
                      <dt className="text-muted">Tool calls</dt>
                      <dd className="measured text-ink-2">{t.result.toolCalls.length}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-muted">Model steps</dt>
                      <dd className="measured text-ink-2">{t.result.steps}</dd>
                    </div>
                    {t.result.costUsd > 0 && (
                      <div className="flex gap-1.5">
                        <dt className="text-muted">Cost</dt>
                        <dd className="measured text-ink-2">${t.result.costUsd.toFixed(4)}</dd>
                      </div>
                    )}
                  </dl>
                  {t.result.fallback && <p className="text-muted">Answer assembled from retrieved code.</p>}
                  {t.result.invalidCitations.length > 0 && (
                    <p className="text-muted">
                      {t.result.invalidCitations.length} invalid citation{t.result.invalidCitations.length === 1 ? "" : "s"} removed.
                    </p>
                  )}
                </div>
              )}
              {t.error && <p className="text-sm text-bad">{t.error}</p>}
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={onSubmit} className="max-w-4xl">
        <label htmlFor="ask-input" className="label">
          Question
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <textarea
            id="ask-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit(question);
              }
            }}
            rows={2}
            placeholder="Ask how something works, where it lives, or why it is built this way…"
            className="field min-h-18 flex-1"
          />
          {running ? (
            <button type="button" onClick={() => abort.current?.abort()} className="btn">
              Stop
            </button>
          ) : (
            <button type="submit" disabled={question.trim().length < 3} className="btn btn--primary">
              Ask
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
