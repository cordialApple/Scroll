export interface DocSummary {
  docId: string
  updatedAt: string
  title: string
  preview: string
}

// The relay speaks ws; its read API rides the same host over http(s). Map the scheme so the picker
// fetches the doc list from wherever the doc socket points.
export function httpBaseFromWs(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '')
}

export async function listDocuments(wsUrl: string, signal?: AbortSignal): Promise<DocSummary[]> {
  const res = await fetch(`${httpBaseFromWs(wsUrl)}/api/documents`, { signal })
  if (!res.ok) throw new Error(`doc list failed (${res.status})`)
  const body = (await res.json()) as { documents?: DocSummary[] }
  return body.documents ?? []
}

export async function renameDocument(wsUrl: string, docId: string, title: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${httpBaseFromWs(wsUrl)}/api/documents/${encodeURIComponent(docId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    signal,
  })
  if (!res.ok) throw new Error(`rename failed (${res.status})`)
}
