import type { ReactNode } from "react";

const CITATION_GROUP = /\[((?:#\d+|[0-9a-f]{7,40})(?:\s*,\s*(?:#\d+|[0-9a-f]{7,40}))*)\]/g;
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*)/g;

function CitationLink({ token, repoUrl }: { token: string; repoUrl: string }) {
  const isPr = token.startsWith("#");
  const href = isPr ? `${repoUrl}/pull/${token.slice(1)}` : `${repoUrl}/commit/${token}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={isPr ? `Pull request ${token}` : `Commit ${token}`}
      className="rounded bg-amber-100 px-1 py-px font-mono text-[0.8em] text-amber-900 no-underline hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/70"
    >
      {isPr ? token : token.slice(0, 7)}
    </a>
  );
}

function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={`${key}-${i}`} className="rounded bg-stone-100 px-1 font-mono text-[0.85em] dark:bg-stone-800">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) return <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

/** One line of text with citations turned into commit/PR links. */
export function CitedLine({ text, repoUrl }: { text: string; repoUrl: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CITATION_GROUP)) {
    nodes.push(...inline(text.slice(last, m.index), `t${last}`));
    const tokens = m[1]!.split(/\s*,\s*/);
    nodes.push(
      <span key={`c${m.index}`} className="inline-flex flex-wrap gap-0.5 align-baseline">
        {tokens.map((t) => (
          <CitationLink key={t} token={t} repoUrl={repoUrl} />
        ))}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  nodes.push(...inline(text.slice(last), `t${last}`));
  return <>{nodes}</>;
}

/** Minimal markdown (paragraphs, bullet lists, `code`, **bold**) with clickable citations. */
export function CitedText({ text, repoUrl }: { text: string; repoUrl: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <div className="space-y-3 leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const bullets = lines.filter((l) => /^\s*[-*] /.test(l));
        const prose = lines.filter((l) => !/^\s*[-*] /.test(l)).join(" ").trim();
        return (
          <div key={i} className="space-y-2">
            {prose && (
              <p>
                <CitedLine text={prose} repoUrl={repoUrl} />
              </p>
            )}
            {bullets.length > 0 && (
              <ul className="list-disc space-y-1 pl-5">
                {bullets.map((b, j) => (
                  <li key={j}>
                    <CitedLine text={b.replace(/^\s*[-*] /, "")} repoUrl={repoUrl} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
