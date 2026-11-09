const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-simple-goal/index.ts"), "utf8");

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
	assert.match(indexSource, /pi-simple-goal\.json/);
});

test("eine wartende Fortsetzung wird verworfen, sobald das Goal nicht mehr aktiv ist", () => {
	assert.match(indexSource, /if \(next\?\.status !== "active"\) \{[\s\S]*?clearContinuationTimer\(\);/);
});

// Automatische Fortsetzungen duerfen den vollen Audit-Text nicht je Turn wiederholen. In einer langen
// Schleife erzeugt die Vollfassung hunderte identische Kopien und sprengt den Kontext.
test("automatische Fortsetzungen nutzen den kurzen Hinweis statt des vollstaendigen Audit-Textes", () => {
	assert.match(indexSource, /case "continuation":\s*return shortContinuationPrompt\(state\);/);
	assert.doesNotMatch(indexSource, /case "active":\s*case "continuation":/);
	assert.match(indexSource, /function shortContinuationPrompt\(state: GoalState\): string \{/);
});

// Eine Kette automatischer Fortsetzungen ohne neuen Input ist ein Blocked-Loop und wird pausiert.
test("die Kette automatischer Fortsetzungen ist begrenzt und wird zurueckgesetzt", () => {
	assert.match(indexSource, /const MAX_CONSECUTIVE_AUTO_CONTINUATIONS = \d+;/);
	assert.match(indexSource, /if \(consecutiveAutoContinuations >= MAX_CONSECUTIVE_AUTO_CONTINUATIONS\) \{/);
	assert.match(indexSource, /if \(autoContinuationPending\) \{\s*consecutiveAutoContinuations \+= 1;\s*autoContinuationPending = false;\s*\} else \{/);
});

// Der Wartezustand beendet den Turn ohne Fortsetzung und wacht mit dem naechsten Turn auf.
test("der Wartezustand unterdrueckt die Fortsetzung und wacht beim naechsten Turn auf", () => {
	assert.match(indexSource, /enum: \["complete", "waiting"\]/);
	assert.match(indexSource, /status: "waiting"/);
	assert.match(indexSource, /if \(goal\?\.status === "waiting"\) \{/);
	assert.match(indexSource, /deliverAs: "nextTurn"/);
});

// Der Zustand gehoert je Extension-Instanz, damit zwei Sitzungen im selben Prozess sich nicht mischen.
test("der Goal-Zustand liegt je Extension-Instanz", () => {
	assert.match(indexSource, /export default function piGoal\(pi: ExtensionAPI\) \{\s*let goal: GoalState \| null = null;/);
});
