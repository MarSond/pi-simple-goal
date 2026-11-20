const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const { loadPolicy } = jiti("../.pi/extensions/pi-simple-goal/index.ts");
const { DEFAULT_POLICY } = jiti("../.pi/extensions/pi-simple-goal/error-policy.ts");

// Run fn with an isolated cwd and HOME so the project and user config layers
// resolve into a temp tree, and the PI_SIMPLE_GOAL_CONFIG env override is removed
// unless set explicitly.
function withConfigEnv({ project, user, envFile }, fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-settings-"));
	const savedCwd = process.cwd();
	const savedHome = process.env.HOME;
	const savedOverride = process.env.PI_SIMPLE_GOAL_CONFIG;
	const write = (rel, value) => {
		const path = join(dir, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(value));
	};
	if (project) write(".pi/pi-simple-goal.json", project);
	if (user) write(join("home", ".pi", "agent", "pi-simple-goal.json"), user);
	if (envFile) write(join("env", "config.json"), envFile);
	process.chdir(dir);
	process.env.HOME = join(dir, "home");
	if (envFile) process.env.PI_SIMPLE_GOAL_CONFIG = join(dir, "env", "config.json");
	else delete process.env.PI_SIMPLE_GOAL_CONFIG;
	try {
		return fn();
	} finally {
		process.chdir(savedCwd);
		process.env.HOME = savedHome;
		if (savedOverride === undefined) delete process.env.PI_SIMPLE_GOAL_CONFIG;
		else process.env.PI_SIMPLE_GOAL_CONFIG = savedOverride;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("loadPolicy returns defaults when no config layer exists", () => {
	withConfigEnv({}, () => {
		assert.deepEqual(loadPolicy(), DEFAULT_POLICY);
	});
});

test("loadPolicy reads the user layer", () => {
	withConfigEnv({ user: { maxConsecutiveErrors: 2 } }, () => {
		const policy = loadPolicy();
		assert.equal(policy.maxConsecutiveErrors, 2);
		assert.deepEqual(policy.backoffSeconds, DEFAULT_POLICY.backoffSeconds);
	});
});

test("loadPolicy lets the project layer override user keys", () => {
	withConfigEnv(
		{
			user: { maxConsecutiveErrors: 2, backoffSeconds: [1, 2] },
			project: { maxConsecutiveErrors: 9 },
		},
		() => {
			const policy = loadPolicy();
			assert.equal(policy.maxConsecutiveErrors, 9);
			assert.deepEqual(policy.backoffSeconds, [1, 2]);
			assert.equal(policy.maxBackoffSeconds, DEFAULT_POLICY.maxBackoffSeconds);
		},
	);
});

test("loadPolicy lets the env override replace all layers", () => {
	withConfigEnv(
		{
			user: { maxConsecutiveErrors: 2 },
			project: { maxConsecutiveErrors: 9 },
			envFile: { maxConsecutiveErrors: 42 },
		},
		() => {
			const policy = loadPolicy();
			assert.equal(policy.maxConsecutiveErrors, 42);
			assert.deepEqual(policy.backoffSeconds, DEFAULT_POLICY.backoffSeconds);
		},
	);
});

test("loadPolicy ignores an unreadable or invalid layer", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-settings-"));
	const savedCwd = process.cwd();
	const savedHome = process.env.HOME;
	const savedOverride = process.env.PI_SIMPLE_GOAL_CONFIG;
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "pi-simple-goal.json"), "{ not json");
	process.chdir(dir);
	process.env.HOME = dir;
	delete process.env.PI_SIMPLE_GOAL_CONFIG;
	try {
		assert.deepEqual(loadPolicy(), DEFAULT_POLICY);
	} finally {
		process.chdir(savedCwd);
		process.env.HOME = savedHome;
		if (savedOverride === undefined) delete process.env.PI_SIMPLE_GOAL_CONFIG;
		else process.env.PI_SIMPLE_GOAL_CONFIG = savedOverride;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadPolicy keeps defaults for missing keys in a layer", () => {
	withConfigEnv({ project: { pauseOnTokenExhausted: false } }, () => {
		const policy = loadPolicy();
		assert.equal(policy.pauseOnTokenExhausted, false);
		assert.equal(policy.maxConsecutiveErrors, DEFAULT_POLICY.maxConsecutiveErrors);
	});
});
