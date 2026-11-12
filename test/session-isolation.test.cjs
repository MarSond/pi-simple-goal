const assert = require("node:assert/strict");
const { join } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename, {
	interopDefault: true,
	alias: {
		"@mariochechner/pi-tui": join(__dirname, "tui-stub.cjs"),
	},
});

function createExtensionApi() {
	const handlers = new Map();
	const tools = new Map();
	const messages = [];
	let activeTools = [];

	return {
		handlers,
		tools,
		messages,
		api: {
			registerMessageRenderer() {},
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			on(event, handler) {
				handlers.set(event, handler);
			},
			sendMessage(message, options) {
				messages.push({ message, options });
			},
			appendEntry() {},
			getActiveTools() {
				return activeTools;
			},
			setActiveTools(next) {
				activeTools = next;
			},
		},
	};
}

function createContext(goal) {
	const entries = goal
		? [{ type: "custom", customType: "pi-goal", data: { goal, statusBarEnabled: true } }]
		: [];
	return {
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
		},
		ui: {
			setStatus() {},
			notify() {},
			async confirm() {
				return true;
			},
		},
		isIdle: () => false,
		hasPendingMessages: () => false,
	};
}

function createGoal(id) {
	return {
		version: 1,
		id,
		objective: `Ziel von ${id}`,
		status: "active",
		tokenBudget: null,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
	};
}

async function runSuccessfulTurn(instance, context) {
	await instance.handlers.get("turn_start")({ turnIndex: 0 }, context);
	await instance.handlers.get("turn_end")(
		{ message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 5 } }, toolResults: [] },
		context,
	);
	await instance.handlers.get("agent_settled")(undefined, context);
	await new Promise(setImmediate);
}

test("Goal-Zustand und Fortsetzung bleiben je Extension-Instanz getrennt", async () => {
	const piGoal = await jiti.import(join(__dirname, "../.pi/extensions/pi-simple-goal/index.ts"), { default: true });
	const sessionA = createExtensionApi();
	const sessionB = createExtensionApi();
	const goalA = createGoal("session-a-goal");
	const contextA = createContext(goalA);
	const contextB = createContext(null);

	piGoal(sessionA.api);
	piGoal(sessionB.api);
	sessionA.handlers.get("session_start")({ reason: "startup" }, contextA);
	sessionB.handlers.get("session_start")({ reason: "startup" }, contextB);

	const goalFromA = JSON.parse((await sessionA.tools.get("get_goal").execute()).content[0].text).goal;
	const goalFromB = JSON.parse((await sessionB.tools.get("get_goal").execute()).content[0].text).goal;
	assert.equal(goalFromA.objective, goalA.objective);
	assert.equal(goalFromB, null);

	// Die Instanz ohne Goal darf keine Fortsetzung ausloesen.
	await runSuccessfulTurn(sessionB, contextB);
	assert.equal(sessionB.messages.length, 0);

	// Die Instanz mit Goal plant genau eine eigene Fortsetzung.
	await runSuccessfulTurn(sessionA, contextA);
	assert.equal(sessionA.messages.length, 1);
	assert.equal(sessionA.messages[0].message.details.goal.objective, goalA.objective);
	assert.equal(sessionA.messages[0].options.deliverAs, "followUp");
});
