"use client";

import Link from "next/link";
import { AppBar } from "@/components/app-bar";

/** Route-level error boundary: something threw while rendering a page. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <AppBar />
      <main className="container py-16">
        <div className="max-w-2xl space-y-4">
          <h1>Something went wrong</h1>
          <p className="text-ink-2">{error.message || "An unexpected error occurred while rendering this page."}</p>
          <div className="flex gap-3">
            <button type="button" onClick={reset} className="btn btn--primary">
              Try again
            </button>
            <Link href="/" className="btn">
              Back to Archaeo
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
