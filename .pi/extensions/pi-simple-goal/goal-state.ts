import type { ErrorKind } from "./error-policy";

export type GoalStatus = "active" | "waiting" | "paused" | "budget_limited" | "complete";

export type GoalState = {
	version: 1;
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	/** Consecutive failed turns since the last successful turn. */
	consecutiveErrors?: number;
	/** Classification of the last error. */
	lastErrorKind?: ErrorKind | null;
	/** Time of the last error in milliseconds. */
	lastErrorAt?: number | null;
	/** Reason for an automatic pause by the error brake. */
	pauseReason?: string | null;
};

export type GoalEventKind =
	| "active"
	| "continuation"
	| "waiting"
	| "paused"
	| "resumed"
	| "cleared"
	| "budget_limited"
	| "complete";

export function parseTokenBudget(input: string): { objective: string; tokenBudget: number | null; error?: string } {
	const match = input.match(/(?:^|\s)--tokens(?:=|\s+)(\S+\s*[kKmM]?)(?:\s|$)/);
	if (!match) return { objective: input.trim(), tokenBudget: null };

	const raw = match[1].replace(/\s+/g, "");
	const suffix = raw.slice(-1).toLowerCase();
	const numeric = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
	const value = Number(numeric);
	if (!Number.isFinite(value) || value <= 0) {
		return { objective: input.trim(), tokenBudget: null, error: "Token budget must be positive." };
	}
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	const tokenBudget = Math.round(value * multiplier);
	const objective = (input.slice(0, match.index) + " " + input.slice((match.index ?? 0) + match[0].length)).trim();
	return { objective, tokenBudget };
}

export function normalizeTokenBudget(value: unknown): { tokenBudget: number | null; error?: string } {
	if (value == null) return { tokenBudget: null };
	const tokenBudget = Math.round(Number(value));
	if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
		return { tokenBudget: null, error: "tokenBudget must be a positive number when provided." };
	}
	return { tokenBudget };
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
	return String(value);
}

export function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/**
 * Footer status line. Always renders, also without a goal, so the bar stays visible
 * after /goal clear. `staleReason` marks an active goal that is not progressing,
 * for example during a brake backoff or right before the stall guard pauses it.
 */
export function statusLine(state: GoalState | null, opts?: { staleReason?: string | null }): string {
	if (!state) return "Goal: none";
	const usage =
		state.tokenBudget != null
			? `${formatElapsed(state.timeUsedSeconds)}, ${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)}`
			: formatElapsed(state.timeUsedSeconds);
	if (state.status === "active") {
		if (opts?.staleReason) return `Goal stale: ${opts.staleReason} (${usage})`;
		return `Goal running (${usage})`;
	}
	if (state.status === "waiting") return `Goal waiting for an external event (${usage})`;
	if (state.status === "paused") {
		const reason = state.pauseReason ? truncateObjective(state.pauseReason, 48) : "no reason";
		return `Goal paused: ${reason} (${usage})`;
	}
	if (state.status === "budget_limited") {
		return state.tokenBudget != null ? `Goal unmet: budget reached (${usage})` : `Goal abandoned (${usage})`;
	}
	return `Goal achieved (${usage})`;
}

export function goalUsage(state: GoalState): string {
	if (state.tokenBudget != null) return `${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)} tokens`;
	return formatElapsed(state.timeUsedSeconds);
}

export function truncateObjective(objective: string, max = 96): string {
	const singleLine = objective.replace(/\s+/g, " ").trim();
	return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

export function goalEventStatus(kind: GoalEventKind): string {
	const labels: Record<GoalEventKind, string> = {
		active: "active",
		continuation: "continuing",
		waiting: "waiting",
		paused: "paused",
		resumed: "resumed",
		cleared: "cleared",
		budget_limited: "budget reached",
		complete: "achieved",
	};
	return labels[kind];
}

export function createGoalState(objective: string, tokenBudget: number | null, now = Date.now(), random = Math.random()): GoalState {
	return {
		version: 1,
		id: `${now}-${random.toString(16).slice(2)}`,
		objective,
		status: "active",
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
		consecutiveErrors: 0,
		lastErrorKind: null,
		lastErrorAt: null,
		pauseReason: null,
	};
}

/** Fill in missing fields from older sessions without losing the state. */
export function normalizeGoalState(state: GoalState | null | undefined): GoalState | null {
	if (!state) return null;
	return {
		...state,
		consecutiveErrors: state.consecutiveErrors ?? 0,
		lastErrorKind: state.lastErrorKind ?? null,
		lastErrorAt: state.lastErrorAt ?? null,
		pauseReason: state.pauseReason ?? null,
	};
}

export function accountGoalTurn(state: GoalState, tokenDelta: number, elapsedSeconds: number, now = Date.now()): GoalState {
	let next: GoalState = {
		...state,
		tokensUsed: state.tokensUsed + Math.max(0, tokenDelta),
		timeUsedSeconds: state.timeUsedSeconds + Math.max(0, elapsedSeconds),
		updatedAt: now,
	};
	if (next.status === "active" && next.tokenBudget != null && next.tokensUsed >= next.tokenBudget) {
		next = { ...next, status: "budget_limited" };
	}
	return next;
}

/** A failed turn counts against the error counter. */
export function accountGoalError(state: GoalState, kind: ErrorKind, now = Date.now()): GoalState {
	return {
		...state,
		consecutiveErrors: (state.consecutiveErrors ?? 0) + 1,
		lastErrorKind: kind,
		lastErrorAt: now,
		updatedAt: now,
	};
}

/** A successful turn resets the error counter. */
export function clearGoalErrors(state: GoalState, now = Date.now()): GoalState {
	if (!state.consecutiveErrors && !state.lastErrorKind && !state.lastErrorAt) return state;
	return {
		...state,
		consecutiveErrors: 0,
		lastErrorKind: null,
		lastErrorAt: null,
		updatedAt: now,
	};
}
