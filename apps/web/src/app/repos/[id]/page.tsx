"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import type { RepoProgressDto } from "@archaeo/shared";
import { RepoStatusCard } from "@/components/repo-status";
import { Timeline } from "@/components/timeline";
import { WhyPanel } from "@/components/why-panel";

export default function RepoPage() {
  const { id } = useParams<{ id: string }>();
  const [progress, setProgress] = useState<RepoProgressDto | null>(null);
  const repo = progress?.repo;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-10">
      <Link href="/" className="text-sm font-medium text-stone-500 hover:text-stone-900 dark:hover:text-stone-100">
        ← Archaeo
      </Link>
      <RepoStatusCard repoId={id} onProgress={setProgress} />
      {repo?.status === "ready" && (
        <>
          <Timeline repoId={id} repoUrl={repo.url} />
          <WhyPanel repoId={id} repoUrl={repo.url} />
        </>
      )}
    </main>
  );
}
