// POST /api/episode: encrypt this run's episode and upload it to 0G Storage -> root hash.
// Built from the agent runtime's own record of the run (server-side evidence, policy, tx hash),
// not from anything the browser claims. The browser only says which run and how it ended.
import { logEpisode, type Episode } from "@cpay/zerog";
import { EpisodeRequest } from "../../../lib/api.js";
import { storageOptions } from "../../../lib/server/config.js";
import { fail, failFromError, ok } from "../../../lib/server/respond.js";
import { getRun, keepEvidence, stamp } from "../../../lib/server/runs.js";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const parsed = EpisodeRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "bad_request", "bad episode request");
  const run = getRun(parsed.data.runId);
  // The server's own outcome wins when it has one (e.g. it really paid).
  const decision = run.decision === "paid" ? "paid" : parsed.data.outcome;
  stamp(run, "episode");

  const episode: Episode = {
    decision,
    requestIds: run.evidence.map((e) => e.requestId).filter((x): x is string => !!x),
    receipts: run.evidence.map((e) => e.receipt ?? null),
    txHash: run.payment?.transferHash ?? null,
    timestamps: { ...run.timestamps },
    policyResult: run.policy
      ? { decision: run.policy.decision, checks: run.policy.checks.map((c) => ({ id: c.id, ok: c.ok })) }
      : null,
  };

  let storage;
  try {
    storage = storageOptions();
  } catch (e) {
    return failFromError(e, "zerog-storage", run);
  }
  try {
    const r = await logEpisode(episode, storage.episodeKey, storage.opts);
    await keepEvidence(run, r.evidence);
    return ok({ rootHash: r.rootHash, txHash: r.txHash, requestIds: episode.requestIds, evidence: run.evidence });
  } catch (e) {
    return failFromError(e, "zerog-storage", run);
  }
}
