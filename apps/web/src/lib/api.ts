import type { RepoDto, RepoProgressDto } from "@archaeo/shared";

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
  createRepo: (url: string) => request<RepoDto>("/repos", { method: "POST", body: JSON.stringify({ url }) }),
  getRepo: (id: string) => request<RepoDto>(`/repos/${id}`),
  getProgress: (id: string) => request<RepoProgressDto>(`/repos/${id}/progress`),
  reingest: (id: string) => request<RepoDto>(`/repos/${id}/ingest`, { method: "POST" }),
};
