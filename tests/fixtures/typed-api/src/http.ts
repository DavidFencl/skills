// A small axios-like client: every call resolves to { data, status, headers }.
export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

async function send<T>(method: string, url: string, body?: unknown): Promise<HttpResponse<T>> {
  const response = await fetch(`/api${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { data: (await response.json()) as T, status: response.status, headers: {} };
}

export const http = {
  get: <T>(url: string) => send<T>('GET', url),
  post: <T>(url: string, body: unknown) => send<T>('POST', url, body),
};
