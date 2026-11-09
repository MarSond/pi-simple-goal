const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	DEFAULT_POLICY,
	backoffSeconds,
	classifyError,
	createBrakeState,
	decide,
	describeKind,
	normalizeSignature,
	resetBrakeState,
} = jiti("../.pi/extensions/pi-simple-goal/error-policy.ts");

test("classifyError trennt Verbindung, Ratelimit, Kontingent und Kontextüberlauf", () => {
	assert.equal(classifyError("Connection error."), "connection");
	assert.equal(classifyError("fetch failed: ECONNREFUSED"), "connection");
	assert.equal(classifyError("socket hang up"), "connection");
	assert.equal(classifyError("request timed out"), "connection");
	assert.equal(classifyError("429 Too Many Requests"), "rate_limit");
	assert.equal(classifyError("rate limit exceeded"), "rate_limit");
	assert.equal(classifyError("insufficient_quota"), "quota");
	assert.equal(classifyError("monthly usage limit reached"), "quota");
	assert.equal(classifyError("context window exceeds limit (2013)"), "token_exhausted");
	assert.equal(classifyError("Prompt is too long"), "token_exhausted");
	assert.equal(classifyError("something else entirely"), "other");
	assert.equal(classifyError(undefined), "other");
});

test("normalizeSignature ersetzt IDs und Zahlen, damit gleiche Ursache gleiche Signatur ergibt", () => {
	const a = normalizeSignature("Error req_abc123 failed after 4711 ms");
	const b = normalizeSignature("Error req_zzz999 failed after 1200 ms");
	assert.equal(a, b);
	assert.notEqual(a, normalizeSignature("Connection error."));
});

test("backoffSeconds steigt die Leiter und bleibt unter dem Deckel", () => {
	const policy = { ...DEFAULT_POLICY, backoffSeconds: [5, 15, 60], maxBackoffSeconds: 30 };
	assert.equal(backoffSeconds(1, policy), 5);
	assert.equal(backoffSeconds(2, policy), 15);
	assert.equal(backoffSeconds(3, policy), 30);
	assert.equal(backoffSeconds(9, policy), 30);
});

test("decide wartet beim ersten Fehler und zählt gleiche Signaturen fort", () => {
	let state = createBrakeState();
	const first = decide(state, "connection", "conn", DEFAULT_POLICY);
	assert.equal(first.decision.action, "retry");
	assert.equal(first.decision.delaySeconds, DEFAULT_POLICY.backoffSeconds[0]);
	state = first.state;

	const second = decide(state, "connection", "conn", DEFAULT_POLICY);
	assert.equal(second.decision.action, "retry");
	assert.equal(second.decision.delaySeconds, DEFAULT_POLICY.backoffSeconds[1]);
	assert.equal(second.state.consecutiveErrors, 2);
});

test("decide beginnt bei einer neuen Fehlersignatur neu", () => {
	let state = createBrakeState();
	state = decide(state, "connection", "conn", DEFAULT_POLICY).state;
	state = decide(state, "connection", "conn", DEFAULT_POLICY).state;
	const other = decide(state, "connection", "timeout", DEFAULT_POLICY);
	assert.equal(other.state.consecutiveErrors, 1);
});

test("decide pausiert nach der konfigurierten Fehlerzahl", () => {
	const policy = { ...DEFAULT_POLICY, maxConsecutiveErrors: 3 };
	let state = createBrakeState();
	state = decide(state, "connection", "conn", policy).state;
	state = decide(state, "connection", "conn", policy).state;
	const third = decide(state, "connection", "conn", policy);
	assert.equal(third.decision.action, "pause");
	assert.match(third.decision.reason, /3 aufeinanderfolgende Fehler/);
});

test("decide pausiert sofort bei Kontextüberlauf und bei erschöpftem Kontingent", () => {
	const overflow = decide(createBrakeState(), "token_exhausted", "ctx", DEFAULT_POLICY);
	assert.equal(overflow.decision.action, "pause");
	assert.match(overflow.decision.reason, /Kontext/);

	const quota = decide(createBrakeState(), "quota", "quota", DEFAULT_POLICY);
	assert.equal(quota.decision.action, "pause");
	assert.match(quota.decision.reason, /Kontingent/);
});

test("resetBrakeState setzt Zähler und Signatur zurück", () => {
	const state = { signature: "conn", consecutiveErrors: 4, kind: "connection", lastErrorAt: 1 };
	assert.deepEqual(resetBrakeState(), {
		signature: null,
		consecutiveErrors: 0,
		kind: null,
		lastErrorAt: null,
	});
	assert.deepEqual(state.signature, "conn");
});

test("describeKind benennt jeden Fehlertyp", () => {
	assert.equal(describeKind("connection"), "Verbindungsfehler");
	assert.equal(describeKind("rate_limit"), "Ratelimit");
	assert.equal(describeKind("token_exhausted"), "Kontext- oder Token-Erschöpfung");
	assert.equal(describeKind("quota"), "Provider-Kontingent erschöpft");
	assert.equal(describeKind("other"), "unbekannter Fehler");
});
