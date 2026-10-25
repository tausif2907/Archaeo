/** Unified diff with added/removed lines colored. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <pre className="max-h-96 overflow-auto rounded-lg border border-stone-200 bg-stone-50 py-2 font-mono text-xs leading-5 dark:border-stone-800 dark:bg-stone-950">
      {lines.map((l, i) => {
        const cls = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ")
          ? "font-semibold text-stone-700 dark:text-stone-300"
          : l.startsWith("@@")
            ? "bg-sky-50 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300"
            : l.startsWith("+")
              ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200"
              : l.startsWith("-")
                ? "bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-200"
                : "text-stone-600 dark:text-stone-400";
        return (
          <div key={i} className={`whitespace-pre px-3 ${cls}`}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}
