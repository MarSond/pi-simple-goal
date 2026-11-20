const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-simple-goal/index.ts"), "utf8");

test("the continuation is planned after agent_settled, not after agent_end", () => {
	assert.match(indexSource, /pi\.on\("agent_settled"/);
	assert.doesNotMatch(indexSource, /pi\.on\("agent_end"/);
});

test("a failed turn triggers the error brake, not the next continuation immediately", () => {
	assert.match(indexSource, /outcome === "error" \|\| outcome === "aborted"/);
	assert.match(indexSource, /applyBrake\(pi, ctx, outcome\)/);
	assert.match(indexSource, /settledOutcome = outcomeOf\(message\)/);
});

test("the brake uses classification, threshold, and backoff from the configuration", () => {
	assert.match(indexSource, /classifyError\(lastErrorMessage\)/);
	assert.match(indexSource, /decide\(brake, kind, signature, policy\)/);
	assert.match(indexSource, /loadPolicy\(liveOverrides\)/);
	assert.match(indexSource, /pi-simple-goal\.json/);
});

test("a pending continuation is dropped once the goal is no longer active", () => {
	assert.match(indexSource, /if \(next\?\.status !== "active"\) \{[\s\S]*?clearContinuationTimer\(\);/);
});

// Automatic continuations must not repeat the full audit text on every turn. In a long loop the full
// version would create hundreds of identical copies and blow up the context.
test("automatic continuations use the short hint instead of the full audit text", () => {
	assert.match(indexSource, /case "continuation":\s*return shortContinuationPrompt\(state\);/);
	assert.doesNotMatch(indexSource, /case "active":\s*case "continuation":/);
	assert.match(indexSource, /function shortContinuationPrompt\(state: GoalState\): string \{/);
});

// The waiting state ends the turn without a continuation and wakes up with the next turn.
test("the waiting state suppresses the continuation and wakes on the next turn", () => {
	assert.match(indexSource, /enum: \["complete", "waiting"\]/);
	assert.match(indexSource, /status: "waiting"/);
	assert.match(indexSource, /goal\?\.status === "waiting" && waitingSettled && !autoContinuationPending/);
	// Waiting must not trigger a sendMessage: every delivery starts a turn and lifts the state.
	assert.doesNotMatch(indexSource, /deliverAs: "nextTurn"/);
});

// The state belongs per extension instance so two sessions in the same process do not mix.
test("the goal state lives per extension instance", () => {
	assert.match(indexSource, /export default function piGoal\(pi: ExtensionAPI\) \{\s*let goal: GoalState \| null = null;/);
});

// The error state belongs in the goal state, not only in module memory. After a restart in the middle
// of an error chain the counter must keep running, not start at zero.
test("the error state is persisted in the goal state and cleared on success", () => {
	assert.match(indexSource, /persist\(pi, ctx, accountGoalError\(goal, kind\)\)/);
	assert.match(indexSource, /\.\.\.accountGoalError\(goal, kind\)/);
	assert.match(indexSource, /goal = clearGoalErrors\(goal\);/);
});

// After /goal resume no stale pause reason may remain, otherwise /goal status contradicts the state.
test("a resume clears the pause reason", () => {
	assert.match(indexSource, /if \(status === "active"\) next\.pauseReason = null;/);
});
