import type { RepoDto } from "@archaeo/shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export const api = {
  createRepo: (url: string) => request<RepoDto>("/repos", { method: "POST", body: JSON.stringify({ url }) }),
  getRepo: (id: string) => request<RepoDto>(`/repos/${id}`),
};
