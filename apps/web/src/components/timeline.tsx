"use client";

import { useEffect, useMemo, useState } from "react";
import type { EraDto, ErasResponse } from "@archaeo/shared";
import { api } from "@/lib/api";
import { useAppConfig } from "@/lib/use-config";
import { CitedText } from "./cited-text";
import { fmt } from "./repo-status";

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
  const publicDemo = useAppConfig()?.publicDemo === true;
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
    <section className="space-y-5" aria-labelledby="timeline-heading">
      <div className="flex items-center justify-between gap-4">
        <h2 id="timeline-heading">Timeline</h2>
        {data && !busy && !publicDemo && (
          <button type="button" onClick={regenerate} className="btn">
            Regenerate
          </button>
        )}
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
      {busy && (
        <p className="text-sm text-ink-2 motion-safe:animate-pulse" role="status">
          {data?.message ?? "Reading the history…"}
        </p>
      )}
      {data?.status === "failed" && <p className="text-sm text-bad">Era generation failed: {data.message}</p>}
      {data && !busy && data.status !== "failed" && eras.length === 0 && <p className="well px-4 py-6 text-sm text-muted">No eras yet.</p>}
      {!data && !error && <div className="skeleton h-16 motion-safe:animate-pulse" aria-busy="true" aria-label="Loading the timeline" />}

      {eras.length > 0 && (
        <>
          <div>
            <div className="flex h-16 gap-px overflow-x-auto rounded-card border border-rule bg-rule" role="tablist" aria-label="Eras">
              {eras.map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  role="tab"
                  aria-selected={i === selected}
                  title={`${e.title} (${monthYear(e.startDate)} to ${monthYear(e.endDate)})`}
                  onClick={() => setSelected(i)}
                  style={{ width: `${widths[i]}%` }}
                  className={`relative min-w-18 shrink-0 cursor-pointer px-2 text-left transition-colors duration-200 ${
                    i === selected
                      ? "bg-accent-soft text-ink before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent"
                      : "bg-paper-2 text-ink-2 hover:bg-paper-hover active:bg-paper-3"
                  }`}
                >
                  <span className="measured block truncate text-sm">{i + 1}</span>
                  <span className={`measured block truncate text-xs ${i === selected ? "text-ink-2" : "text-muted"}`}>
                    {year(e.startDate) === year(e.endDate) ? year(e.startDate) : `${year(e.startDate)}/${String(year(e.endDate)).slice(2)}`}
                  </span>
                </button>
              ))}
            </div>
            <div className="measured mt-1.5 flex justify-between text-xs text-muted">
              <span>{monthYear(eras[0]!.startDate)}</span>
              <span>{monthYear(eras[eras.length - 1]!.endDate)}</span>
            </div>
          </div>

          {era && (
            <article className="panel space-y-6 p-6" role="tabpanel">
              <header className="space-y-4">
                <h3 className="text-xl">{era.title}</h3>
                <dl className="flex flex-wrap gap-x-8 gap-y-2">
                  <div>
                    <dt className="text-xs text-muted">Era</dt>
                    <dd className="measured text-ink">
                      {selected + 1} of {eras.length}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Period</dt>
                    <dd className="measured text-ink">
                      {monthYear(era.startDate)} to {monthYear(era.endDate)}
                    </dd>
                  </div>
                  {era.stats && (
                    <>
                      <div>
                        <dt className="text-xs text-muted">Commits</dt>
                        <dd className="measured text-ink">{fmt(era.stats.commits)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Contributors</dt>
                        <dd className="measured text-ink">{era.stats.contributors}</dd>
                      </div>
                      {era.stats.releases.length > 0 && (
                        <div>
                          <dt className="text-xs text-muted">Releases</dt>
                          <dd className="measured text-ink">{era.stats.releases.length}</dd>
                        </div>
                      )}
                    </>
                  )}
                </dl>
              </header>

              {era.narrative && <CitedText text={era.narrative} repoUrl={repoUrl} />}

              <div className="grid gap-6 border-t border-rule pt-5 text-sm sm:grid-cols-2">
                {era.keyPrs.length > 0 && (
                  <div>
                    <h4 className="mb-2 font-medium text-ink">Key pull requests</h4>
                    <ul className="space-y-1.5">
                      {era.keyPrs.map((p) => (
                        <li key={p.number} className="flex gap-3">
                          <a href={`${repoUrl}/pull/${p.number}`} target="_blank" rel="noreferrer" className="ref ref--person shrink-0">
                            #{p.number}
                          </a>
                          <span className="min-w-0 text-ink-2">{p.title}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {era.keyCommits.length > 0 && (
                  <div>
                    <h4 className="mb-2 font-medium text-ink">Key commits</h4>
                    <ul className="space-y-1.5">
                      {era.keyCommits.map((c) => (
                        <li key={c.sha} className="flex gap-3">
                          <a href={`${repoUrl}/commit/${c.sha}`} target="_blank" rel="noreferrer" className="ref ref--person shrink-0">
                            {c.shortSha}
                          </a>
                          <span className="min-w-0 break-words text-ink-2">{c.subject}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {era.stats && era.stats.topAreas.length > 0 && (
                <div className="border-t border-rule pt-5 text-sm">
                  <h4 className="mb-3 font-medium text-ink">Activity</h4>
                  <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                    {era.stats.topAreas.map((a) => (
                      <li key={a.area} className="space-y-1.5">
                        <div className="flex justify-between gap-3">
                          <span className={a.area === "(root)" ? "truncate text-ink-2" : "measured truncate text-ink-2"}>{a.area === "(root)" ? "top-level files" : a.area}</span>
                          <span className="measured shrink-0 text-muted">{a.percent}%</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-rule">
                          <div className="h-full origin-left rounded-full bg-cool" style={{ transform: `scaleX(${Math.min(100, a.percent) / 100})` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          )}
          {data?.message && <p className="text-xs text-muted">{data.message}</p>}
        </>
      )}
    </section>
  );
}
