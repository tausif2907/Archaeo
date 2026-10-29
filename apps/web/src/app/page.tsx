import { RepoIntake } from "@/components/repo-intake";

export default function HomePage() {
  return (
    <main className="container grid content-start gap-x-8 gap-y-10 py-16 lg:grid-cols-12 lg:py-24">
      <header className="space-y-4 lg:col-span-5 lg:row-start-1">
        <h1>Archaeo</h1>
        <p className="lead text-ink-2">Point Archaeo at any GitHub repo to understand its past, see its present, and fix its future.</p>
      </header>
      <RepoIntake />
    </main>
  );
}
