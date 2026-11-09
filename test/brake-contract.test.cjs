const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal-brake/index.ts"), "utf8");

test("die Fortsetzung wird nach agent_settled geplant, nicht nach agent_end", () => {
	assert.match(indexSource, /pi\.on\("agent_settled"/);
	assert.doesNotMatch(indexSource, /pi\.on\("agent_end"/);
});

test("ein Fehlerturn löst die Fehler-Bremse aus, nicht sofort die nächste Fortsetzung", () => {
	assert.match(indexSource, /outcome === "error" \|\| outcome === "aborted"/);
	assert.match(indexSource, /applyBrake\(pi, ctx, outcome\)/);
	assert.match(indexSource, /settledOutcome = outcomeOf\(message\)/);
});

test("die Bremse nutzt Klassifikation, Schwelle und Backoff aus der Konfiguration", () => {
	assert.match(indexSource, /classifyError\(lastErrorMessage\)/);
	assert.match(indexSource, /decide\(brake, kind, signature, policy\)/);
	assert.match(indexSource, /loadPolicy\(\)/);
	assert.match(indexSource, /pi-goal-brake\.json/);
});

test("eine wartende Fortsetzung wird verworfen, sobald das Goal nicht mehr aktiv ist", () => {
	assert.match(indexSource, /if \(next\?\.status !== "active"\) \{[\s\S]*?clearContinuationTimer\(\);/);
});
