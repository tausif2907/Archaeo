import Link from "next/link";
import type { ReactNode } from "react";

/** Top bar: the wordmark goes home; a page may add its own context on the right. */
export function AppBar({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b border-rule">
      <div className="container flex min-h-14 items-center justify-between gap-4">
        <Link href="/" aria-label="Archaeo home" className="link text-md font-medium text-ink no-underline">
          Archaeo
        </Link>
        {children}
      </div>
    </header>
  );
}
