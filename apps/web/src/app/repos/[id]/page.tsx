"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { RepoProgressDto } from "@archaeo/shared";
import { AppBar } from "@/components/app-bar";
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
    <>
      <AppBar />
      <main className="container flex flex-col gap-8 pt-8 pb-16 lg:pt-10">
        <RepoStatusCard repoId={id} onProgress={setProgress} />
        {repo?.status === "ready" && (
          <CodeViewerProvider repoId={id} repoUrl={repo.url}>
            <nav className="-mt-2 flex overflow-x-auto border-b border-rule" role="tablist" aria-label="Views">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => select(t.id)} className="tab">
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
    </>
  );
}
