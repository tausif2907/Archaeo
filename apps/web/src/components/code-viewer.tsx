"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { CodeFile, CodeRef } from "@archaeo/shared";
import { api } from "@/lib/api";

interface Viewer {
  open(ref: CodeRef): void;
}

const ViewerContext = createContext<Viewer | null>(null);

export function useCodeViewer(): Viewer | null {
  return useContext(ViewerContext);
}

/** Provides `open(ref)` to cited text and renders the code drawer. */
export function CodeViewerProvider({ repoId, repoUrl, children }: { repoId: string; repoUrl: string; children: ReactNode }) {
  const [ref, setRef] = useState<CodeRef | null>(null);
  const open = useCallback((r: CodeRef) => setRef(r), []);
  return (
    <ViewerContext.Provider value={{ open }}>
      {children}
      {ref && <CodeDrawer repoId={repoId} repoUrl={repoUrl} target={ref} onClose={() => setRef(null)} />}
    </ViewerContext.Provider>
  );
}

function CodeDrawer({ repoId, repoUrl, target, onClose }: { repoId: string; repoUrl: string; target: CodeRef; onClose: () => void }) {
  const [file, setFile] = useState<CodeFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstLine = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    setFile(null);
    setError(null);
    api.file(repoId, target.path).then(setFile, (err: Error) => setError(err.message));
  }, [repoId, target.path]);

  useEffect(() => {
    firstLine.current?.scrollIntoView({ block: "center" });
  }, [file, target.startLine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-(--z-modal) flex justify-end bg-scrim" onClick={onClose} role="presentation">
      <aside
        role="dialog"
        aria-label={`${target.path} lines ${target.startLine}-${target.endLine}`}
        className="flex h-full w-full max-w-3xl flex-col border-l border-rule bg-paper-2"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-rule px-5 py-3">
          <div className="min-w-0 space-y-0.5">
            <p className="measured truncate text-sm text-cool">{target.path}</p>
            <p className="flex flex-wrap gap-x-4 text-xs text-muted">
              <span className="measured">
                Lines {target.startLine} to {target.endLine}
                {file && ` of ${file.totalLines}`}
              </span>
              <a href={`${repoUrl}/blob/HEAD/${target.path}#L${target.startLine}-L${target.endLine}`} target="_blank" rel="noreferrer" className="link">
                View on GitHub
              </a>
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn btn--ghost" aria-label="Close code viewer" autoFocus>
            Close
          </button>
        </header>
        <div className="flex-1 overflow-auto bg-paper-3">
          {error && <p className="p-5 text-sm text-bad">{error}</p>}
          {!file && !error && <p className="p-5 text-sm text-muted motion-safe:animate-pulse">Loading…</p>}
          {file && (
            <table className="measured w-full border-collapse text-xs leading-5">
              <tbody>
                {file.lines.map((line, i) => {
                  const n = i + 1;
                  const hit = n >= target.startLine && n <= target.endLine;
                  return (
                    <tr key={n} ref={n === target.startLine ? firstLine : undefined} className={hit ? "bg-cool-soft text-ink" : "text-ink-2"}>
                      <td className={`select-none border-r border-rule px-3 text-right align-top ${hit ? "text-cool" : "text-muted"}`}>{n}</td>
                      <td className="whitespace-pre px-3">{line || " "}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {file?.truncated && <p className="p-5 text-xs text-muted">File truncated after {file.lines.length} lines.</p>}
        </div>
      </aside>
    </div>
  );
}
