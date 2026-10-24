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
    <div className="fixed inset-0 z-50 flex justify-end bg-stone-950/30" onClick={onClose} role="presentation">
      <aside
        role="dialog"
        aria-label={`${target.path} lines ${target.startLine}-${target.endLine}`}
        className="flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
          <div className="min-w-0">
            <p className="truncate font-mono text-sm font-medium">{target.path}</p>
            <p className="text-xs text-stone-500">
              Lines {target.startLine}–{target.endLine}
              {file && ` of ${file.totalLines}`} ·{" "}
              <a href={`${repoUrl}/blob/HEAD/${target.path}#L${target.startLine}-L${target.endLine}`} target="_blank" rel="noreferrer" className="hover:underline">
                View on GitHub
              </a>
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800" aria-label="Close code viewer">
            Close
          </button>
        </header>
        <div className="flex-1 overflow-auto">
          {error && <p className="p-4 text-sm text-red-600">{error}</p>}
          {!file && !error && <p className="animate-pulse p-4 text-sm text-stone-500">Loading…</p>}
          {file && (
            <table className="w-full border-collapse font-mono text-xs leading-5">
              <tbody>
                {file.lines.map((line, i) => {
                  const n = i + 1;
                  const hit = n >= target.startLine && n <= target.endLine;
                  return (
                    <tr key={n} ref={n === target.startLine ? firstLine : undefined} className={hit ? "bg-amber-100 dark:bg-amber-900/40" : undefined}>
                      <td className="select-none border-r border-stone-200 px-3 text-right align-top text-stone-400 dark:border-stone-800">{n}</td>
                      <td className="whitespace-pre px-3">{line || " "}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {file?.truncated && <p className="p-4 text-xs text-stone-500">File truncated after {file.lines.length} lines.</p>}
        </div>
      </aside>
    </div>
  );
}
