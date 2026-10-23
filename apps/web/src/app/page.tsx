import { RepoIntake } from "@/components/repo-intake";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-4 py-16">
      <header className="space-y-2">
        <h1 className="text-4xl font-semibold tracking-tight">Archaeo</h1>
        <p className="text-stone-600 dark:text-stone-400">
          Point Archaeo at any GitHub repo to understand its past, see its present, and fix its future.
        </p>
      </header>
      <RepoIntake />
    </main>
  );
}
