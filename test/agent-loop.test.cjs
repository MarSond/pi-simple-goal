const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const piGoal = jiti("../.pi/extensions/pi-simple-goal/index.ts").default;

// Minimale ExtensionAPI- und ExtensionContext-Mocks, die den echten Extension-Code treiben.
function createHarness() {
	const handlers = {};
	const sent = [];
	const entries = [];
	const tools = {};
	const state = { idle: true, pending: false };

	const pi = {
		on: (event, fn) => {
			handlers[event] = fn;
		},
		registerMessageRenderer: () => {},
		registerTool: (tool) => {
			tools[tool.name] = tool;
		},
		registerCommand: () => {},
		sendMessage: (message, options) => {
			sent.push({ kind: message.details?.kind, options, content: message.content });
		},
		appendEntry: (type, data) => {
			entries.push({ type, data });
		},
		getActiveTools: () => [],
		setActiveTools: () => {},
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
		await handlers.turn_start(undefined, ctx);
		await handlers.turn_end({ message: successfulMessage }, ctx);
		await handlers.agent_settled(undefined, ctx);
		await flush();
	}

	return { pi, ctx, handlers, sent, tools, state, currentGoal, continuations, flush, successfulTurn };
}

test("ein wartendes Goal unterdrueckt die Fortsetzung und wacht mit dem naechsten Turn auf", async () => {
	const h = createHarness();
	piGoal(h.pi);
	await h.handlers.session_start({ reason: "startup" }, h.ctx);

	const created = await h.tools.create_goal.execute("1", { objective: "test objective" }, undefined, undefined, h.ctx);
	assert.equal(created.isError, undefined);
	assert.equal(h.sent.at(-1).kind, "active");

	// Grundfall: ein erfolgreicher Turn mit aktivem Goal plant genau eine Fortsetzung.
	await h.successfulTurn();
	assert.equal(h.continuations(), 1);

	// Das Goal wartet auf ein externes Ereignis, etwa eine Meldung eines Hintergrundlaufs.
	const waited = await h.tools.update_goal.execute("2", { status: "waiting" }, undefined, undefined, h.ctx);
	assert.equal(waited.isError, undefined);
	assert.equal(h.currentGoal().status, "waiting");
	// Das Wartungsereignis darf den Agenten nicht wecken, sonst startet es einen Turn,
	// aktiviert das Goal wieder und schaerft die Schleife neu.
	assert.equal(h.sent.at(-1).options?.deliverAs, "nextTurn");
	assert.equal(h.sent.at(-1).options?.triggerTurn, undefined);

	// Im selben Turn wird keine Fortsetzung geplant. Der Turn endet ohne neuen turn_start,
	// sonst waecht das Goal sofort wieder auf.
	await h.handlers.turn_end({ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 5 } } }, h.ctx);
	await h.handlers.agent_settled(undefined, h.ctx);
	await h.flush();
	assert.equal(h.continuations(), 1);

	// Ein extern ausgeloester Turn weckt das Goal wieder.
	await h.handlers.turn_start(undefined, h.ctx);
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
