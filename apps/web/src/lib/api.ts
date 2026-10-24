import type { ErasResponse, FileEntry, RepoDto, RepoProgressDto, SymbolEntry, WhyInput, WhyResult } from "@archaeo/shared";

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
};
