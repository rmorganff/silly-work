/**
 * monday.com GraphQL API, read-only (MONDAY_API_TOKEN). Only queries are ever sent; there is no mutation anywhere in this file.
 */
export class MondayError extends Error {
  constructor(public code: string, public status?: number) { super(code); }
}

export interface MItem { id: string; name: string; created_at: string; updated_at: string; group: { id: string; title: string } | null; columns: { id: string; title: string; type: string; text: string }[] }
export interface MBoard { id: string; name: string; groups: { id: string; title: string }[]; items: MItem[]; truncated: boolean }
export interface MBoardRef { id: string; name: string }

export interface Monday {
  me(): Promise<{ id: string }>;
  listBoards(): Promise<MBoardRef[]>;
  board(id: string, maxItems?: number): Promise<MBoard>;
}

const ITEM_FIELDS = 'id name created_at updated_at group { id title } column_values { id type text column { title } }';
const toItem = (x: any): MItem => ({
  id: String(x.id), name: String(x.name ?? ''), created_at: x.created_at, updated_at: x.updated_at, group: x.group ? { id: String(x.group.id), title: String(x.group.title) } : null,
  columns: (x.column_values ?? []).map((c: any) => ({ id: String(c.id), title: String(c.column?.title ?? c.id), type: String(c.type ?? ''), text: String(c.text ?? '') })),
});

export function makeMonday(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Monday | null {
  const token = env.MONDAY_API_TOKEN;
  if (!token) return null;
  async function q(query: string, variables: Record<string, unknown> = {}): Promise<any> {
    if (!/^\s*query\b/.test(query)) throw new MondayError('read_only_client');
    const r = await fetchImpl('https://api.monday.com/v2', { method: 'POST', headers: { authorization: token!, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok || data.errors?.length || data.error_code) {
      const code = String(data.error_code ?? data.errors?.[0]?.extensions?.code ?? data.errors?.[0]?.message ?? `http_${r.status}`).slice(0, 80);
      throw new MondayError(code, r.status);
    }
    return data.data;
  }
  return {
    async me() { const d = await q('query { me { id } }'); return { id: String(d.me.id) }; },
    async listBoards() {
      const out: MBoardRef[] = [];
      for (let page = 1; page <= 10; page++) {
        const d = await q('query($page:Int){ boards(limit: 100, page: $page, state: active) { id name } }', { page });
        const got = d.boards ?? [];
        out.push(...got.map((b: any) => ({ id: String(b.id), name: String(b.name) })));
        if (got.length < 100) break;
      }
      return out;
    },
    async board(id, maxItems = 1500) {
      const first = await q(`query($ids:[ID!]){ boards(ids:$ids) { id name groups { id title } items_page(limit: 200) { cursor items { ${ITEM_FIELDS} } } } }`, { ids: [id] });
      const b = first.boards?.[0];
      if (!b) throw new MondayError('board_not_found');
      const items: MItem[] = (b.items_page?.items ?? []).map(toItem);
      let cursor: string | null = b.items_page?.cursor ?? null, truncated = false;
      while (cursor) {
        if (items.length >= maxItems) { truncated = true; break; }
        const n = await q(`query($cursor:String!){ next_items_page(limit: 200, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } } }`, { cursor });
        items.push(...(n.next_items_page?.items ?? []).map(toItem));
        cursor = n.next_items_page?.cursor ?? null;
      }
      return { id: String(b.id), name: String(b.name), groups: (b.groups ?? []).map((g: any) => ({ id: String(g.id), title: String(g.title) })), items, truncated };
    },
  };
}
