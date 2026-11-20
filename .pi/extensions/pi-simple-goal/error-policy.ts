/**
 * Error brake for the goal plugin.
 *
 * Based on two published solutions in the pi-goal ecosystem, both MIT like pi-goal itself:
 *   - the recovery planning from `manthedan/pi-goal` (error classification, retry windows, pause on exhaustion)
 *   - the continuation control via `agent_settled` from `patlux/pi-goal` (Pi first finishes its own
 *     retry and compaction recovery before the goal plans further)
 *
 * What is specific here is the configurability: thresholds and wait times come from config files, so a run
 * brakes without manual intervention and the values stay adjustable.
 */

export type ErrorKind = "connection" | "rate_limit" | "token_exhausted" | "quota" | "other";

export type BrakePolicy = {
	/** Consecutive failed turns the goal tolerates before it pauses itself. */
	maxConsecutiveErrors: number;
	/** Wait times in seconds, index 0 for the first error. */
	backoffSeconds: number[];
	/** Upper bound for the wait time in seconds. */
	maxBackoffSeconds: number;
	/** Pause instead of retrying after a context overflow. */
	pauseOnTokenExhausted: boolean;
};

export const DEFAULT_POLICY: BrakePolicy = {
	maxConsecutiveErrors: 5,
	backoffSeconds: [5, 15, 60, 300],
	maxBackoffSeconds: 300,
	pauseOnTokenExhausted: true,
};

export type BrakeState = {
	/** Signature of the last error, so identical errors count on and new ones restart the count. */
	signature: string | null;
	/** Consecutive errors. */
	consecutiveErrors: number;
	/** Classification of the last error. */
	kind: ErrorKind | null;
	/** Time of the last error in milliseconds. */
	lastErrorAt: number | null;
};

export type BrakeDecision = {
	action: "retry" | "pause";
	delaySeconds: number;
	reason: string | null;
	kind: ErrorKind;
};

export function createBrakeState(): BrakeState {
	return { signature: null, consecutiveErrors: 0, kind: null, lastErrorAt: null };
}

export function resetBrakeState(): BrakeState {
	return { signature: null, consecutiveErrors: 0, kind: null, lastErrorAt: null };
}

const TOKEN_EXHAUSTED =
	/context.?overflow|context.?window|maximum context|context length|too many tokens|tokens exceed|input is too long|request too large|prompt is too long|too long/i;
const QUOTA_EXHAUSTED = /usage limit|monthly usage|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const RATE_LIMIT = /rate.?limit|too many requests|429|resource.?exhausted|overloaded/i;
const CONNECTION =
	/connection|network|econnrefused|econnreset|econnaborted|enotfound|etimedout|socket hang up|fetch failed|websocket.?closed|upstream|stream ended|timed? ?out|timeout|terminated/i;

export function classifyError(errorMessage: string | null | undefined): ErrorKind {
	const text = errorMessage ?? "";
	if (TOKEN_EXHAUSTED.test(text)) return "token_exhausted";
	if (QUOTA_EXHAUSTED.test(text)) return "quota";
	if (RATE_LIMIT.test(text)) return "rate_limit";
	if (CONNECTION.test(text)) return "connection";
	return "other";
}

/** Error signature: the same cause yields the same signature, varying numbers and IDs are replaced. */
export function normalizeSignature(errorMessage: string | null | undefined): string {
	const firstLine = (errorMessage ?? "unknown_error").trim().split("\n")[0] ?? "unknown_error";
	return firstLine
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
		.replace(/\breq[_-][a-z0-9-]+\b/gi, "req_<id>")
		.replace(/\b\d{4,}\b/g, "<n>")
		.slice(0, 180);
}

export function backoffSeconds(attempt: number, policy: BrakePolicy = DEFAULT_POLICY): number {
	const ladder = policy.backoffSeconds.length > 0 ? policy.backoffSeconds : DEFAULT_POLICY.backoffSeconds;
	const index = Math.min(Math.max(attempt, 1), ladder.length) - 1;
	const base = ladder[index] ?? ladder.at(-1) ?? 60;
	return Math.min(Math.max(0, base), Math.max(0, policy.maxBackoffSeconds));
}

/**
 * Decision after a failed turn. Identical error signatures keep counting, a new signature restarts the count.
 */
export function decide(
	state: BrakeState,
	kind: ErrorKind,
	signature: string,
	policy: BrakePolicy = DEFAULT_POLICY,
	now = Date.now(),
): { state: BrakeState; decision: BrakeDecision } {
	const sameSignature = state.signature === signature;
	const consecutiveErrors = sameSignature ? state.consecutiveErrors + 1 : 1;
	const next: BrakeState = { signature, consecutiveErrors, kind, lastErrorAt: now };

	if (kind === "token_exhausted" && policy.pauseOnTokenExhausted) {
		return {
			state: next,
			decision: {
				action: "pause",
				delaySeconds: 0,
				reason: "Context or token exhaustion. Continuing would only grow the context.",
				kind,
			},
		};
	}
	if (kind === "quota") {
		return {
			state: next,
			decision: {
				action: "pause",
				delaySeconds: 0,
				reason: "Provider quota exhausted. Continuing would only produce failed turns.",
				kind,
			},
		};
	}
	if (consecutiveErrors >= policy.maxConsecutiveErrors) {
		return {
			state: next,
			decision: {
				action: "pause",
				delaySeconds: 0,
				reason: `${consecutiveErrors} consecutive errors (${describeKind(kind)}). The goal pauses instead of keeping the run going.`,
				kind,
			},
		};
	}
	return {
		state: next,
		decision: { action: "retry", delaySeconds: backoffSeconds(consecutiveErrors, policy), reason: null, kind },
	};
}

export function describeKind(kind: ErrorKind): string {
	switch (kind) {
		case "connection":
			return "connection error";
		case "rate_limit":
			return "rate limit";
		case "token_exhausted":
			return "context or token exhaustion";
		case "quota":
			return "provider quota exhausted";
		case "other":
			return "unknown error";
		default:
			return "unknown error";
	}
}
