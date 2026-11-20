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

test("classifyError separates connection, rate limit, quota, and context overflow", () => {
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

test("normalizeSignature replaces IDs and numbers so the same cause yields the same signature", () => {
	const a = normalizeSignature("Error req_abc123 failed after 4711 ms");
	const b = normalizeSignature("Error req_zzz999 failed after 1200 ms");
	assert.equal(a, b);
	assert.notEqual(a, normalizeSignature("Connection error."));
});

test("backoffSeconds climbs the ladder and stays under the cap", () => {
	const policy = { ...DEFAULT_POLICY, backoffSeconds: [5, 15, 60], maxBackoffSeconds: 30 };
	assert.equal(backoffSeconds(1, policy), 5);
	assert.equal(backoffSeconds(2, policy), 15);
	assert.equal(backoffSeconds(3, policy), 30);
	assert.equal(backoffSeconds(9, policy), 30);
});

test("decide waits on the first error and keeps counting identical signatures", () => {
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

test("decide restarts the count on a new error signature", () => {
	let state = createBrakeState();
	state = decide(state, "connection", "conn", DEFAULT_POLICY).state;
	state = decide(state, "connection", "conn", DEFAULT_POLICY).state;
	const other = decide(state, "connection", "timeout", DEFAULT_POLICY);
	assert.equal(other.state.consecutiveErrors, 1);
});

test("decide pauses after the configured error count", () => {
	const policy = { ...DEFAULT_POLICY, maxConsecutiveErrors: 3 };
	let state = createBrakeState();
	state = decide(state, "connection", "conn", policy).state;
	state = decide(state, "connection", "conn", policy).state;
	const third = decide(state, "connection", "conn", policy);
	assert.equal(third.decision.action, "pause");
	assert.match(third.decision.reason, /3 consecutive errors/);
});

test("decide pauses immediately on context overflow and exhausted quota", () => {
	const overflow = decide(createBrakeState(), "token_exhausted", "ctx", DEFAULT_POLICY);
	assert.equal(overflow.decision.action, "pause");
	assert.match(overflow.decision.reason, /Context/);

	const quota = decide(createBrakeState(), "quota", "quota", DEFAULT_POLICY);
	assert.equal(quota.decision.action, "pause");
	assert.match(quota.decision.reason, /quota/);
});

test("resetBrakeState resets counter and signature", () => {
	const state = { signature: "conn", consecutiveErrors: 4, kind: "connection", lastErrorAt: 1 };
	assert.deepEqual(resetBrakeState(), {
		signature: null,
		consecutiveErrors: 0,
		kind: null,
		lastErrorAt: null,
	});
	assert.deepEqual(state.signature, "conn");
});

test("describeKind names every error kind", () => {
	assert.equal(describeKind("connection"), "connection error");
	assert.equal(describeKind("rate_limit"), "rate limit");
	assert.equal(describeKind("token_exhausted"), "context or token exhaustion");
	assert.equal(describeKind("quota"), "provider quota exhausted");
	assert.equal(describeKind("other"), "unknown error");
});
