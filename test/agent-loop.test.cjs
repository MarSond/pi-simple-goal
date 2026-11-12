const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const piGoal = jiti("../.pi/extensions/pi-simple-goal/index.ts").default;

// Minimale ExtensionAPI- und ExtensionContext-Mocks, die den echten Extension-Code treiben.
function createHarness(initialEntries = []) {
	const handlers = {};
	const sent = [];
	const entries = [...initialEntries];
	const tools = {};
	const commands = {};
	let activeTools = ["bash", "read"];
	const state = { idle: true, pending: false };

	const pi = {
		on: (event, fn) => {
			handlers[event] = fn;
		},
		registerMessageRenderer: () => {},
		registerTool: (tool) => {
			tools[tool.name] = tool;
		},
		registerCommand: (name, command) => { commands[name] = command; },
		sendMessage: (message, options) => {
			sent.push({ kind: message.details?.kind, options, content: message.content });
		},
		appendEntry: (type, data) => {
			entries.push({ type: "custom", customType: type, data });
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
	};
	const ctx = {
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		ui: { setStatus: () => {}, notify: () => {}, confirm: async () => true },
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
	};
	const currentGoal = () => entries.at(-1).data.goal;
	const continuations = () => sent.filter((item) => item.kind === "continuation").length;
	const flush = () => new Promise((resolve) => setImmediate(resolve));
	const successfulMessage = { role: "assistant", stopReason: "stop", usage: { totalTokens: 10 } };

	async function successfulTurn() {
		await handlers.turn_start({ turnIndex: 0 }, ctx);
		await handlers.turn_end({ message: successfulMessage, toolResults: [] }, ctx);
		await handlers.agent_settled(undefined, ctx);
		await flush();
	}

	async function callTool(name, params = {}) {
		assert.ok(activeTools.includes(name), `${name} muss fuer das Modell sichtbar sein`);
		return tools[name].execute("test", params, undefined, undefined, ctx);
	}
	return { pi, ctx, handlers, sent, tools, commands, state, entries, currentGoal, continuations, flush, successfulTurn,
		callTool, activeTools: () => [...activeTools] };
}

test("ein wartendes Goal unterdrueckt die Fortsetzung und wacht mit dem naechsten Turn auf", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);

	const created = await h.callTool("create_goal", { objective: "test objective" });
	assert.equal(created.isError, undefined);
	assert.equal(h.sent.at(-1).kind, "active");

	// Grundfall: ein erfolgreicher Turn mit aktivem Goal plant genau eine Fortsetzung.
	await h.successfulTurn();
	assert.equal(h.continuations(), 1);

	// Das Goal wartet auf ein externes Ereignis, etwa eine Meldung eines Hintergrundlaufs.
	const waited = await h.callTool("update_goal", { status: "waiting" });
	assert.equal(waited.isError, undefined);
	assert.equal(h.currentGoal().status, "waiting");
	// Das Wartungsereignis darf den Agenten nicht wecken, sonst startet es einen Turn,
	// aktiviert das Goal wieder und schaerft die Schleife neu.
	// Kein sendMessage beim Warten: jede Zustellung startet einen Turn, `turn_start` setzt den
	// Wartezustand wieder auf aktiv und die Schleife beginnt von vorn.
	assert.notEqual(h.sent.at(-1).kind, "waiting");

	// Im selben Turn wird keine Fortsetzung geplant. Der Turn endet ohne neuen turn_start,
	// sonst waecht das Goal sofort wieder auf.
	await h.handlers.turn_end({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 5 } }, toolResults: [] }, h.ctx);
	await h.handlers.agent_settled(undefined, h.ctx);
	await h.flush();
	assert.equal(h.continuations(), 1);

	// Ein extern ausgeloester Turn weckt das Goal wieder.
	await h.handlers.turn_start({ turnIndex: 0 }, h.ctx);
	assert.equal(h.currentGoal().status, "active");

	// Danach laeuft die normale Fortsetzung wieder.
	await h.successfulTurn();
	assert.equal(h.continuations(), 2);
});

test("update_goal lehnt unbekannte Zustaende ab und bleibt beim Warten idempotent", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);

	const noGoal = await h.tools.update_goal.execute("1", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(noGoal.isError, true);

	await h.tools.create_goal.execute("2", { objective: "test objective" }, undefined, undefined, h.ctx);
	const waited = await h.tools.update_goal.execute("3", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(waited.isError, undefined);
	const again = await h.tools.update_goal.execute("4", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(again.isError, undefined);
	const invalid = await h.tools.update_goal.execute("5", { status: "paused" }, undefined, undefined, h.ctx);
	assert.equal(invalid.isError, true);
	assert.match(invalid.content[0].text, /only accepts status=complete or status=waiting/);
});

async function setupGoal(initialEntries) {
	const h = createHarness(initialEntries);
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);
	if (!initialEntries) await h.callTool("create_goal", { objective: "Dienst bis Nutzerende, dann Uebergabe" });
	return h;
}

test("Abbruch pausiert; normale Nachricht liest und beendet ohne Resume und ohne neue Fortsetzung", async () => {
	const h = await setupGoal();
	await h.handlers.turn_start({ turnIndex: 0 }, h.ctx);
	await h.handlers.turn_end({ message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }, h.ctx);
	await h.handlers.agent_settled(undefined, h.ctx);
	await h.flush();
	assert.equal(h.currentGoal().status, "paused");
	assert.match(h.currentGoal().pauseReason, /abgebrochen/);
	assert.equal(h.continuations(), 0);

	// Ein neuer Prompt darf die Unterbrechung nicht aufheben. Der Abschlussbericht braucht kein Resume.
	await h.handlers.turn_start({ turnIndex: 0 }, h.ctx);
	const read = await h.callTool("get_goal");
	assert.equal(read.details.goal.status, "paused");
	assert.equal(h.currentGoal().status, "paused");
	const waiting = await h.callTool("update_goal", { status: "waiting" });
	assert.equal(waiting.isError, true);
	await h.callTool("update_goal", { status: "complete" });
	await h.handlers.turn_end({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, h.ctx);
	await h.handlers.agent_settled(undefined, h.ctx);
	await h.flush();
	assert.equal(h.currentGoal().status, "complete");
	assert.equal((await h.callTool("get_goal")).details.goal.status, "complete");
	assert.equal(h.activeTools().includes("update_goal"), false);
	assert.equal(h.continuations(), 0);
	assert.ok(h.activeTools().includes("bash"));
	assert.ok(h.activeTools().includes("read"));
});

test("pausiertes Goal bleibt nach Wiederaufnahme der Sitzung pausiert; nur /goal resume aktiviert es", async () => {
	const h = await setupGoal();
	await h.commands.goal.handler("pause", h.ctx);
	const restored = await setupGoal(h.entries);
	await restored.successfulTurn();
	assert.equal((await restored.callTool("get_goal")).details.goal.status, "paused");
	assert.equal(restored.continuations(), 0);
	await restored.commands.goal.handler("resume", restored.ctx);
	await restored.flush();
	assert.equal(restored.currentGoal().status, "active");
	assert.equal(restored.continuations(), 1);
});

test("waiting plant keinen Timer; ein wiederhergestelltes wartendes Goal wacht beim externen Lauf auf", async () => {
	const h = await setupGoal();
	await h.callTool("update_goal", { status: "waiting" });
	await h.successfulTurn();
	assert.equal(h.currentGoal().status, "waiting");
	assert.equal(h.continuations(), 0);
	const restored = await setupGoal(h.entries);
	assert.equal((await restored.callTool("get_goal")).details.goal.status, "waiting");
	await restored.successfulTurn();
	assert.equal(restored.currentGoal().status, "active");
	assert.equal(restored.continuations(), 1);
});

test("fuenf werkzeuglose automatische Laeufe pausieren; ein externer Lauf beginnt eine neue Kette", async () => {
	const h = await setupGoal();
	await h.successfulTurn();
	for (let i = 0; i < 4; i++) await h.successfulTurn();
	assert.equal(h.currentGoal().status, "active");
	await h.successfulTurn();
	assert.equal(h.currentGoal().status, "paused");
	assert.match(h.currentGoal().pauseReason, /ohne Werkzeugaufruf/);
	assert.equal(h.continuations(), 5);

	const other = await setupGoal();
	await other.successfulTurn();
	for (let i = 0; i < 4; i++) await other.successfulTurn();
	// Eine echte Nachricht wartet bereits; nach diesem Lauf wird kein Reminder eingereiht.
	other.state.pending = true;
	await other.successfulTurn();
	other.state.pending = false;
	await other.successfulTurn();
	assert.equal(other.currentGoal().status, "active");
	for (let i = 0; i < 4; i++) await other.successfulTurn();
	assert.equal(other.currentGoal().status, "active");
	await other.successfulTurn();
	assert.equal(other.currentGoal().status, "paused");
});

test("Werkzeug-Folgeturns gelten nicht als neue Nutzernachrichten; Werkzeugnutzung unterbricht die Bremse", async () => {
	const h = await setupGoal();
	await h.successfulTurn();
	for (let i = 0; i < 8; i++) {
		await h.handlers.turn_start({ turnIndex: 0 }, h.ctx);
		await h.handlers.turn_end({ message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ role: "toolResult" }] }, h.ctx);
		await h.handlers.turn_start({ turnIndex: 1 }, h.ctx);
		await h.handlers.turn_end({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, h.ctx);
		await h.handlers.agent_settled(undefined, h.ctx);
		await h.flush();
		assert.equal(h.currentGoal().status, "active");
	}
	for (let i = 0; i < 4; i++) await h.successfulTurn();
	assert.equal(h.currentGoal().status, "active");
	await h.successfulTurn();
	assert.equal(h.currentGoal().status, "paused");
});
