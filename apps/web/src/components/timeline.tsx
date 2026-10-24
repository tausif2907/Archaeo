"use client";

import { useEffect, useMemo, useState } from "react";
import type { EraDto, ErasResponse } from "@archaeo/shared";
import { api } from "@/lib/api";
import { CitedText } from "./cited-text";
import { fmt } from "./repo-status";

const SEGMENT_COLORS = [
  "bg-amber-200 dark:bg-amber-900/60",
  "bg-orange-200 dark:bg-orange-900/60",
  "bg-rose-200 dark:bg-rose-900/60",
  "bg-violet-200 dark:bg-violet-900/60",
  "bg-sky-200 dark:bg-sky-900/60",
  "bg-teal-200 dark:bg-teal-900/60",
];

const monthYear = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const year = (iso: string) => new Date(iso).getUTCFullYear();

/** Segment widths blend real duration with an equal share, so short bursts stay clickable. */
function segmentWidths(eras: EraDto[]): number[] {
  const durations = eras.map((e) => Math.max(1, new Date(e.endDate).getTime() - new Date(e.startDate).getTime()));
  const total = durations.reduce((a, b) => a + b, 0);
  return durations.map((d) => (0.5 * (d / total) + 0.5 / eras.length) * 100);
}

export function Timeline({ repoId, repoUrl }: { repoId: string; repoUrl: string }) {
  const [data, setData] = useState<ErasResponse | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy = data?.status === "pending" || data?.status === "running";

  useEffect(() => {
    let cancelled = false;
    const load = () => api.eras(repoId).then((d) => !cancelled && setData(d), (err: Error) => !cancelled && setError(err.message));
    load();
    if (data && !busy) return () => void (cancelled = true);
    const timer = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [repoId, busy]);

  const eras = data?.eras ?? [];
  const widths = useMemo(() => segmentWidths(eras), [eras]);
  const era = eras[Math.min(selected, eras.length - 1)];

  async function regenerate() {
    setError(null);
    try {
      await api.regenerateEras(repoId);
      setData((d) => (d ? { ...d, status: "pending" } : d));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="timeline-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="timeline-heading" className="text-lg font-semibold">
          Timeline
        </h2>
        {data && !busy && (
          <button type="button" onClick={regenerate} className="text-sm font-medium text-stone-600 underline-offset-4 hover:underline dark:text-stone-400">
            Regenerate
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {busy && <p className="animate-pulse text-sm text-stone-600 dark:text-stone-400">{data?.message ?? "Reading the history…"}</p>}
      {data?.status === "failed" && <p className="text-sm text-red-600 dark:text-red-400">Era generation failed: {data.message}</p>}
      {data && !busy && data.status !== "failed" && eras.length === 0 && <p className="text-sm text-stone-500">No eras yet.</p>}

      {eras.length > 0 && (
        <>
          <div>
            <div className="flex h-12 gap-0.5 overflow-hidden rounded-lg" role="tablist" aria-label="Eras">
              {eras.map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  role="tab"
                  aria-selected={i === selected}
                  title={`${e.title} (${monthYear(e.startDate)} – ${monthYear(e.endDate)})`}
                  onClick={() => setSelected(i)}
                  style={{ width: `${widths[i]}%` }}
                  className={`min-w-0 px-1.5 text-left text-xs transition ${SEGMENT_COLORS[i % SEGMENT_COLORS.length]} ${
                    i === selected ? "ring-2 ring-inset ring-stone-900 dark:ring-stone-100" : "opacity-70 hover:opacity-100"
                  }`}
                >
                  <span className="block truncate font-medium">{i + 1}</span>
                  <span className="block truncate tabular-nums text-stone-600 dark:text-stone-300">
                    {year(e.startDate) === year(e.endDate) ? year(e.startDate) : `${year(e.startDate)}–${String(year(e.endDate)).slice(2)}`}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-xs tabular-nums text-stone-500">
              <span>{monthYear(eras[0]!.startDate)}</span>
              <span>{monthYear(eras[eras.length - 1]!.endDate)}</span>
            </div>
          </div>

          {era && (
            <article className="space-y-4 rounded-xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900" role="tabpanel">
              <header className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                  Era {selected + 1} of {eras.length} · {monthYear(era.startDate)} – {monthYear(era.endDate)}
                </p>
                <h3 className="text-lg font-semibold">{era.title}</h3>
                {era.stats && (
                  <p className="text-sm text-stone-600 dark:text-stone-400">
                    {fmt(era.stats.commits)} commits · {era.stats.contributors} contributors
                    {era.stats.releases.length > 0 && ` · ${era.stats.releases.length} release${era.stats.releases.length === 1 ? "" : "s"}`}
                  </p>
                )}
              </header>

              {era.narrative && <CitedText text={era.narrative} repoUrl={repoUrl} />}

              <div className="grid gap-4 border-t border-stone-200 pt-4 text-sm sm:grid-cols-2 dark:border-stone-800">
                {era.keyPrs.length > 0 && (
                  <div>
                    <h4 className="mb-2 font-medium">Key pull requests</h4>
                    <ul className="space-y-1.5">
                      {era.keyPrs.map((p) => (
                        <li key={p.number} className="flex gap-2">
                          <a href={`${repoUrl}/pull/${p.number}`} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-amber-800 hover:underline dark:text-amber-300">
                            #{p.number}
                          </a>
                          <span className="min-w-0">{p.title}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {era.keyCommits.length > 0 && (
                  <div>
                    <h4 className="mb-2 font-medium">Key commits</h4>
                    <ul className="space-y-1.5">
                      {era.keyCommits.map((c) => (
                        <li key={c.sha} className="flex gap-2">
                          <a href={`${repoUrl}/commit/${c.sha}`} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-amber-800 hover:underline dark:text-amber-300">
                            {c.shortSha}
                          </a>
                          <span className="min-w-0 break-words">{c.subject}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {era.stats && era.stats.topAreas.length > 0 && (
                <p className="text-xs text-stone-500">
                  Activity: {era.stats.topAreas.map((a) => `${a.area === "(root)" ? "top-level files" : a.area} ${a.percent}%`).join(" · ")}
                </p>
              )}
            </article>
          )}
          {data?.message && <p className="text-xs text-stone-500">{data.message}</p>}
        </>
      )}
    </section>
  );
}
