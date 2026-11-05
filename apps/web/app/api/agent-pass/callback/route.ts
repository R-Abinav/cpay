// GET /api/agent-pass/callback: World Agent Pass redirect target. @cpay/world validates state, nonce, acr
// and auth_time; we record the outcome for the bound session and tell the /pay window (same origin only).
// The approval itself stays server-side and is consumed (once) by /api/pay.
import { handleAgentPassCallback, type ApprovalResult } from "@cpay/world";
import { errorMessage, isNotImplemented } from "../../../../lib/deps.js";
import { agentPassConfig } from "../../../../lib/server/config.js";
import { setAgentPass } from "../../../../lib/server/runs.js";

export const runtime = "nodejs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(origin: string, msg: { approved: boolean; reason: string; sessionId: string | null }): Response {
  const title = msg.approved ? "Approved" : "Not approved";
  // JSON inside <script>: escape "<" so no value can close the tag.
  const data = JSON.stringify({ type: "cpay-agent-pass", ...msg }).replace(/</g, "\\u003c");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CPay Agent Pass</title></head>
<body style="font-family:system-ui,sans-serif;background:#0a0a0a;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="text-align:center;padding:2rem"><h1>${esc(title)}</h1><p>${esc(msg.reason)}</p><p>You can close this window.</p></main>
<script>(function(){var d=${data};try{if(window.opener){window.opener.postMessage(d,${JSON.stringify(origin)});setTimeout(function(){window.close()},1500)}}catch(e){}})();</script>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let r: ApprovalResult;
  try {
    r = await handleAgentPassCallback(agentPassConfig(), url);
  } catch (e) {
    const reason = isNotImplemented(e) ? "Agent Pass not connected (@cpay/world not implemented yet)" : errorMessage(e);
    return page(url.origin, { approved: false, reason, sessionId: null });
  }
  const sessionId = r.binding?.sessionId ?? null;
  if (r.binding) setAgentPass(r.binding.sessionId, { state: r.approved ? "approved" : "denied", reason: r.reason, binding: r.binding });
  return page(url.origin, { approved: r.approved, reason: r.reason, sessionId });
}
