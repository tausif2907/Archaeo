/** Unified diff: added lines on the ok tint, removed on the bad tint, hunks in the instrument colour. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <pre className="measured max-h-96 overflow-auto rounded-pill bg-paper-3 py-2 text-xs leading-5">
      {lines.map((l, i) => {
        const cls = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ")
          ? "font-medium text-ink"
          : l.startsWith("@@")
            ? "bg-cool-soft text-cool"
            : l.startsWith("+")
              ? "bg-ok-soft text-ok"
              : l.startsWith("-")
                ? "bg-bad-soft text-bad"
                : "text-ink-2";
        return (
          <div key={i} className={`whitespace-pre px-3 ${cls}`}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}
