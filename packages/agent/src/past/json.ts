/** Extracts the first JSON object from model output (tolerates code fences and surrounding prose). */
export function parseJsonObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(content.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** First paragraph of a PR body without HTML comments, checklists or template boilerplate. */
export function cleanExcerpt(body: string | null, max = 400): string {
  if (!body) return "";
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((l) => !/^\s*(- \[[ x]\]|#+\s|>|\|)/i.test(l))
    // "Resolves #12", "Fixes #3, closes #4": references, not a description
    .map((l) => l.replace(/\b(resolves?|fix(es)?|closes?|refs?|see)\s+#\d+(\s*\([^)]*\))?[,.]?/gi, "").trim())
    .join("\n")
    .replace(/\r/g, "")
    .trim()
    .split(/\n\s*\n/)
    .find((p) => p.trim().length > 20) ?? "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function subjectOf(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function monthYear(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
