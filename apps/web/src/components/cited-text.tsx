"use client";

import type { ReactNode } from "react";
import type { CodeRef } from "@archaeo/shared";
import { useCodeViewer } from "./code-viewer";

const TOKEN = String.raw`(?:#\d+|[0-9a-f]{7,40}|[\w./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?)`;
const CITATION_GROUP = new RegExp(String.raw`\[(${TOKEN}(?:\s*,\s*${TOKEN})*)\]`, "g");
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*)/g;
const CODE_REF = /^([\w./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?$/;

function parseRef(token: string): CodeRef | null {
  const m = CODE_REF.exec(token);
  return m ? { path: m[1]!, startLine: Number(m[2]), endLine: Number(m[3] ?? m[2]) } : null;
}

const PILL = "measured rounded-chip px-1 py-px text-[0.82em] no-underline transition-colors duration-200";

function Citation({ token, repoUrl }: { token: string; repoUrl: string }) {
  const viewer = useCodeViewer();
  const ref = parseRef(token);
  if (ref) {
    const label = token.length > 48 ? `…${token.slice(-46)}` : token;
    return viewer ? (
      <button
        type="button"
        onClick={() => viewer.open(ref)}
        title={`Open ${token}`}
        className={`${PILL} cursor-pointer bg-cool-soft text-cool hover:bg-cool/25 active:bg-cool/15`}
      >
        {label}
      </button>
    ) : (
      <a
        href={`${repoUrl}/blob/HEAD/${ref.path}#L${ref.startLine}-L${ref.endLine}`}
        target="_blank"
        rel="noreferrer"
        className={`${PILL} bg-cool-soft text-cool hover:bg-cool/25`}
      >
        {label}
      </a>
    );
  }
  const isPr = token.startsWith("#");
  return (
    <a
      href={isPr ? `${repoUrl}/pull/${token.slice(1)}` : `${repoUrl}/commit/${token}`}
      target="_blank"
      rel="noreferrer"
      title={isPr ? `Pull request ${token}` : `Commit ${token}`}
      className={`${PILL} bg-accent-soft text-accent hover:bg-accent/25 active:bg-accent/15`}
    >
      {isPr ? token : token.slice(0, 7)}
    </a>
  );
}

function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={`${key}-${i}`} className="measured rounded-chip bg-paper-3 px-1 text-[0.85em] text-ink">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) return <strong key={`${key}-${i}`} className="font-medium text-ink">{part.slice(2, -2)}</strong>;
    return part;
  });
}

/** One line of text with commit, PR and code citations turned into links. */
export function CitedLine({ text, repoUrl }: { text: string; repoUrl: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CITATION_GROUP)) {
    nodes.push(...inline(text.slice(last, m.index), `t${last}`));
    nodes.push(
      <span key={`c${m.index}`} className="inline-flex flex-wrap gap-0.5 align-baseline">
        {m[1]!.split(/\s*,\s*/).map((t) => (
          <Citation key={t} token={t} repoUrl={repoUrl} />
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
    <div className="max-w-[72ch] space-y-3 leading-relaxed text-ink-2">
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
              <ul className="list-disc space-y-1 pl-5 marker:text-muted">
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
