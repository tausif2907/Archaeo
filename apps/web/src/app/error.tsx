"use client";

import Link from "next/link";

/** Route-level error boundary: something threw while rendering a page. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 px-4 py-16">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-stone-600 dark:text-stone-400">{error.message || "An unexpected error occurred while rendering this page."}</p>
      <div className="flex gap-3">
        <button type="button" onClick={reset} className="rounded-lg bg-stone-900 px-4 py-2 font-medium text-white dark:bg-stone-100 dark:text-stone-900">
          Try again
        </button>
        <Link href="/" className="rounded-lg border border-stone-300 px-4 py-2 font-medium dark:border-stone-700">
          Back to Archaeo
        </Link>
      </div>
    </main>
  );
}
