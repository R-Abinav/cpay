// GET /api/agent-pass/callback: World Agent Pass redirect target. @cpay/world validates state, nonce, acr,
// auth_time and the linked account, and (approve) signs the single-use approval token. The token itself
// is NOT put in this page: the phone picks it up once from /api/agent-pass/status. This page only tells
// the opener (same origin) that the attempt finished.
import { handleAgentPassCallback, type ApprovalResult } from "@cpay/world";
import { errorMessage, isNotImplemented } from "../../../../lib/deps.js";
import { agentPassConfig } from "../../../../lib/server/config.js";

export const runtime = "nodejs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(origin: string, msg: { approved: boolean; reason: string; attempt: string | null }): Response {
  const title = msg.approved ? "Approved" : "Not approved";
  // JSON inside <script>: escape "<" so no value can close the tag.
  const data = JSON.stringify({ type: "cpay-agent-pass", ...msg }).replace(/</g, "\\u003c");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CPay Agent Pass</title></head>
<body style="font-family:system-ui,sans-serif;background:#0a0a0a;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="text-align:center;padding:2rem"><h1>${esc(title)}</h1><p>${esc(msg.reason)}</p><p>You can close this window and go back to CPay.</p></main>
<script>(function(){var d=${data};try{if(window.opener){window.opener.postMessage(d,${JSON.stringify(origin)});setTimeout(function(){window.close()},1500)}}catch(e){}})();</script>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const attempt = url.searchParams.get("state");
  let r: ApprovalResult;
  try {
    r = await handleAgentPassCallback(agentPassConfig(), url);
  } catch (e) {
    const reason = isNotImplemented(e) ? "Agent Pass not connected" : errorMessage(e);
    return page(url.origin, { approved: false, reason, attempt });
  }
  return page(url.origin, { approved: r.approved, reason: r.reason, attempt });
}
