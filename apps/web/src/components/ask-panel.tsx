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
    <section className="space-y-5" aria-labelledby="ask-heading">
      <h2 id="ask-heading" className="text-lg font-semibold">
        Ask the codebase
      </h2>

      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => void submit(s)} className="rounded-full border border-stone-300 px-3 py-1 text-sm text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800">
              {s}
            </button>
          ))}
        </div>
      )}

      <ol className="space-y-6">
        {turns.map((t, i) => (
          <li key={i} className="space-y-3">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-stone-900 px-4 py-2 text-white dark:bg-stone-100 dark:text-stone-900">{t.question}</p>
            <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
              {t.activity.length > 0 && (
                <ul className="space-y-1 text-xs text-stone-500">
                  {t.activity.map((a) => (
                    <li key={a.id} className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.done ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`} />
                      <span className="truncate">{a.label}</span>
                    </li>
                  ))}
                </ul>
              )}
              {t.notes.map((n, j) => (
                <p key={j} className="text-xs italic text-stone-500">
                  {n}
                </p>
              ))}
              {t.running && !t.result && <p className="animate-pulse text-sm text-stone-500">Investigating…</p>}
              {t.result && <CitedText text={t.result.answer} repoUrl={repoUrl} />}
              {t.result && (
                <p className="text-xs text-stone-500">
                  {t.result.toolCalls.length} tool call{t.result.toolCalls.length === 1 ? "" : "s"} · {t.result.steps} model step{t.result.steps === 1 ? "" : "s"}
                  {t.result.costUsd > 0 && ` · $${t.result.costUsd.toFixed(4)}`}
                  {t.result.fallback && " · answer assembled from retrieved code"}
                  {t.result.invalidCitations.length > 0 && ` · ${t.result.invalidCitations.length} invalid citation(s) removed`}
                </p>
              )}
              {t.error && <p className="text-sm text-red-600 dark:text-red-400">{t.error}</p>}
            </div>
          </li>
        ))}
      </ol>

      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="ask-input" className="sr-only">
          Question
        </label>
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
          className="min-w-0 flex-1 resize-y rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-900"
        />
        {running ? (
          <button type="button" onClick={() => abort.current?.abort()} className="rounded-lg border border-stone-300 px-4 py-2 font-medium dark:border-stone-700">
            Stop
          </button>
        ) : (
          <button type="submit" disabled={question.trim().length < 3} className="rounded-lg bg-stone-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900">
            Ask
          </button>
        )}
      </form>
    </section>
  );
}
