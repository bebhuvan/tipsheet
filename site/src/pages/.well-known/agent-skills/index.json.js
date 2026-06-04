import { TIPSHEET_AGENT_SKILL, tipsheetAgentSkillSha256 } from '../../../lib/agent-skill.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString() || 'https://tipsheet.markets/';
  const skillUrl = new URL('/.well-known/agent-skills/tipsheet/SKILL.md', siteUrl).toString();
  const payload = {
    version: '0.2.0',
    skills: [
      {
        name: 'tipsheet',
        type: 'skill-md',
        description: "Use Tipsheet's public feeds and JSON APIs for Indian listed-company disclosure coverage.",
        url: skillUrl,
        sha256: tipsheetAgentSkillSha256(TIPSHEET_AGENT_SKILL),
      },
    ],
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
