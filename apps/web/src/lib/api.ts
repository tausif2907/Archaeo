import type {
  AgentEvent,
  AppConfigDto,
  CodeFile,
  FixRunDto,
  TraceEvent,
  TraceInput,
  TraceRunDto,
  ErasResponse,
  FileEntry,
  FlowInput,
  FlowTrace,
  MapData,
  RepoDto,
  RepoProgressDto,
  SymbolEntry,
  SymbolHit,
  WhyInput,
  WhyResult,
} from "@archaeo/shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

/** POSTs `body` and calls `onEvent` for each server-sent event until the stream ends. */
async function streamSse<E>(path: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !data || event === "done") continue;
      onEvent(JSON.parse(data) as E);
    }
  }
}

export const api = {
  listRepos: () => request<RepoDto[]>("/repos"),
  createRepo: (url: string) => request<RepoDto>("/repos", { method: "POST", body: JSON.stringify({ url }) }),
  getRepo: (id: string) => request<RepoDto>(`/repos/${id}`),
  getProgress: (id: string) => request<RepoProgressDto>(`/repos/${id}/progress`),
  reingest: (id: string) => request<RepoDto>(`/repos/${id}/ingest`, { method: "POST" }),
  eras: (id: string) => request<ErasResponse>(`/repos/${id}/eras`),
  regenerateEras: (id: string) => request<{ status: string }>(`/repos/${id}/eras`, { method: "POST" }),
  files: (id: string) => request<FileEntry[]>(`/repos/${id}/files`),
  symbols: (id: string, path: string) => request<SymbolEntry[]>(`/repos/${id}/symbols?path=${encodeURIComponent(path)}`),
  why: (id: string, input: WhyInput) => request<WhyResult>(`/repos/${id}/why`, { method: "POST", body: JSON.stringify(input) }),
  map: (id: string) => request<MapData>(`/repos/${id}/map`),
  file: (id: string, path: string) => request<CodeFile>(`/repos/${id}/file?path=${encodeURIComponent(path)}`),
  searchSymbols: (id: string, q: string) => request<SymbolHit[]>(`/repos/${id}/symbols/search?q=${encodeURIComponent(q)}`),
  flow: (id: string, input: FlowInput) => request<FlowTrace>(`/repos/${id}/flow`, { method: "POST", body: JSON.stringify(input) }),
  ask: (id: string, question: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal) => streamSse(`/repos/${id}/ask`, { question }, onEvent, signal),
  trace: (id: string, input: TraceInput, onEvent: (e: TraceEvent) => void, signal?: AbortSignal) => streamSse(`/repos/${id}/trace`, input, onEvent, signal),
  config: () => request<AppConfigDto>("/config"),
  cases: (id: string) => request<TraceRunDto[]>(`/repos/${id}/cases`),
  run: <T extends TraceRunDto | FixRunDto>(id: string, runId: string) => request<T>(`/repos/${id}/runs/${runId}`),
  startFix: (id: string, traceRunId: string) => request<FixRunDto>(`/repos/${id}/runs/${traceRunId}/fix`, { method: "POST" }),
  approve: (id: string, attemptId: string) => request<{ prUrl: string; branch: string }>(`/repos/${id}/fix-attempts/${attemptId}/approve`, { method: "POST" }),
};
