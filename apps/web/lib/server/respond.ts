import "server-only";
import { ZeroGUnavailable, type Evidence } from "@cpay/zerog";
import type { ApiFailure } from "../api.js";
import { errorMessage, isNotImplemented, type DependencyId, type StopState } from "../deps.js";
import { NotConfigured } from "./config.js";
import { keepEvidence, type Run } from "./runs.js";

export function fail(
  status: number,
  stop: StopState,
  message: string,
  extra: { dependency?: DependencyId; evidence?: readonly Evidence[] } = {},
): Response {
  const body: ApiFailure = { ok: false, stop, message, dependency: extra.dependency, evidence: [...(extra.evidence ?? [])] as ApiFailure["evidence"] };
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function ok<T extends object>(body: T): Response {
  return Response.json({ ok: true, ...body }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Map an error from a dependency onto a stop state. 0G failures (ZeroGUnavailable or the unwired stub)
 * are BRAIN OFFLINE; their evidence is kept, never dropped.
 */
export async function failFromError(e: unknown, dependency: DependencyId, run: Run | null): Promise<Response> {
  const isZeroG = dependency === "zerog" || dependency === "zerog-storage";
  if (e instanceof ZeroGUnavailable) {
    await keepEvidence(run, e.evidence);
    return fail(503, "brain_offline", e.message, { dependency, evidence: run?.evidence ?? (e.evidence ? [e.evidence] : []) });
  }
  if (e instanceof NotConfigured) {
    return fail(503, isZeroG ? "brain_offline" : "not_connected", e.message, { dependency, evidence: run?.evidence });
  }
  if (isNotImplemented(e)) {
    return fail(503, isZeroG ? "brain_offline" : "not_connected", `${dependency}: not connected (package not implemented yet)`, {
      dependency,
      evidence: run?.evidence,
    });
  }
  // Unknown failure from 0G is still a safe-stop, never a guess.
  if (isZeroG) return fail(503, "brain_offline", errorMessage(e), { dependency, evidence: run?.evidence });
  return fail(502, "error", `${dependency}: ${errorMessage(e)}`, { dependency, evidence: run?.evidence });
}
