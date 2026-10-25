"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { RepoProgressDto } from "@archaeo/shared";
import { ArchitectureMap } from "@/components/arch-map";
import { AskPanel } from "@/components/ask-panel";
import { CodeViewerProvider } from "@/components/code-viewer";
import { FixPanel } from "@/components/fix-panel";
import { RepoStatusCard } from "@/components/repo-status";
import { Timeline } from "@/components/timeline";
import { WhyPanel } from "@/components/why-panel";

const TABS = [
  { id: "map", label: "Map" },
  { id: "ask", label: "Ask" },
  { id: "timeline", label: "Timeline" },
  { id: "why", label: "Why" },
  { id: "fix", label: "Fix" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function RepoPage() {
  const { id } = useParams<{ id: string }>();
  const [progress, setProgress] = useState<RepoProgressDto | null>(null);
  const [tab, setTab] = useState<TabId>("map");
  const repo = progress?.repo;

  // Remember the tab in the URL hash so links can point at a view.
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (TABS.some((t) => t.id === fromHash)) setTab(fromHash as TabId);
  }, []);
  const select = (t: TabId) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10">
      <Link href="/" className="text-sm font-medium text-stone-500 hover:text-stone-900 dark:hover:text-stone-100">
        ← Archaeo
      </Link>
      <RepoStatusCard repoId={id} onProgress={setProgress} />
      {repo?.status === "ready" && (
        <CodeViewerProvider repoId={id} repoUrl={repo.url}>
          <nav className="flex gap-1 border-b border-stone-200 dark:border-stone-800" role="tablist" aria-label="Views">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => select(t.id)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                  tab === t.id ? "border-stone-900 text-stone-900 dark:border-stone-100 dark:text-stone-100" : "border-transparent text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div role="tabpanel">
            {tab === "map" && <ArchitectureMap repoId={id} />}
            {tab === "ask" && <AskPanel repoId={id} repoUrl={repo.url} />}
            {tab === "timeline" && <Timeline repoId={id} repoUrl={repo.url} />}
            {tab === "why" && <WhyPanel repoId={id} repoUrl={repo.url} />}
            {tab === "fix" && <FixPanel repoId={id} repoUrl={repo.url} repoName={`${repo.owner}/${repo.name}`} />}
          </div>
        </CodeViewerProvider>
      )}
    </main>
  );
}
