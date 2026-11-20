/**
 * /api/trigger: compatibility stub for the claude.ai MCP tools the Work Board and desk-bridge.js call
 * (callTool('Claude Code Remote', 'fire_trigger' | 'list_triggers', args)). Stage 3 replaces it with real workers.
 *
 * Until then it is honest: list_triggers answers an empty list (nothing can be woken), and fire_trigger answers an
 * {error} with fired:false, which the bridge already treats as "the fire was refused", never as a wake.
 * Shapes follow desk-bridge.js unwrap(): {data: [...]} for the list; {error} for a refusal.
 */
export function triggerStub(body: any): { status: number; body: Record<string, unknown> } {
  const tool = String(body?.tool ?? '');
  if (tool === 'list_triggers') return { status: 200, body: { data: [], stub: true } };
  if (tool === 'fire_trigger') {
    return { status: 200, body: { fired: false, stub: true, error: 'not_implemented: triggers arrive with the Stage 3 workers', code: 'not_implemented' } };
  }
  return { status: 400, body: { error: 'unknown_tool', code: 'unknown_tool' } };
}
