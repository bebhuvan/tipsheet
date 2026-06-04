import { TIPSHEET_AGENT_SKILL } from '../../../../lib/agent-skill.mjs';

export async function GET() {
  return new Response(TIPSHEET_AGENT_SKILL, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
