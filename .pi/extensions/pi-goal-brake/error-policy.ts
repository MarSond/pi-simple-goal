/**
 * Fehler-Bremse für das Goal-Plugin.
 *
 * Grundlage sind zwei veröffentlichte Lösungen im pi-goal-Ökosystem, beide MIT wie pi-goal selbst:
 *   - die Recovery-Planung von `manthedan/pi-goal` (Fehlerklassifikation, Retry-Fenster, Pause bei Erschöpfung)
 *   - die Fortsetzungssteuerung über `agent_settled` von `patlux/pi-goal` (Pi darf erst seinen eigenen
 *     Wiederholungs- und Komprimierungsversuch beenden, bevor das Goal weiterplant)
 *
 * Eigen ist hier die Konfigurierbarkeit: Schwellen und Wartezeiten kommen aus einer Datei, damit ein Lauf
 * ohne Handeingriff bremst und die Werte anpassbar bleiben.
 */

export type ErrorKind = "connection" | "rate_limit" | "token_exhausted" | "quota" | "other";

export type BrakePolicy = {
	/** Aufeinanderfolgende Fehlerturns, die das Goal noch laufen lässt. */
	maxConsecutiveErrors: number;
	/** Wartezeiten in Sekunden, Index 0 für den ersten Fehler. */
	backoffSeconds: number[];
	/** Deckel für die Wartezeit in Sekunden. */
	maxBackoffSeconds: number;
	/** Nach einem Kontextüberlauf pausieren statt weiterzuversuchen. */
	pauseOnTokenExhausted: boolean;
};

export const DEFAULT_POLICY: BrakePolicy = {
	maxConsecutiveErrors: 5,
	backoffSeconds: [5, 15, 60, 300],
	maxBackoffSeconds: 300,
	pauseOnTokenExhausted: true,
};

export type BrakeState = {
	/** Signatur des letzten Fehlers, damit gleiche Fehler gezählt und andere neu gezählt werden. */
	signature: string | null;
	/** Fehler in Folge. */
	consecutiveErrors: number;
	/** Klassifikation des letzten Fehlers. */
	kind: ErrorKind | null;
	/** Zeitpunkt des letzten Fehlers in Millisekunden. */
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

/** Fehlersignatur: gleiche Ursache ergibt gleiche Signatur, wechselnde Zahlen und IDs werden ersetzt. */
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
 * Entscheidung nach einem Fehlerturn. Gleiche Fehlersignaturen zählen fort, eine neue Signatur beginnt neu.
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
				reason: "Kontext- oder Token-Erschöpfung. Eine weitere Fortsetzung würde den Kontext nur vergrößern.",
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
				reason: "Provider-Kontingent erschöpft. Weiterlaufen erzeugt nur Fehlerturns.",
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
				reason: `${consecutiveErrors} aufeinanderfolgende Fehler (${describeKind(kind)}). Das Goal pausiert, statt weiter zu laufen.`,
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
			return "Verbindungsfehler";
		case "rate_limit":
			return "Ratelimit";
		case "token_exhausted":
			return "Kontext- oder Token-Erschöpfung";
		case "quota":
			return "Provider-Kontingent erschöpft";
		case "other":
			return "unbekannter Fehler";
		default:
			return "unbekannter Fehler";
	}
}
