# pi-goal-brake

Persistent autonomous goals for [pi](https://github.com/badlogic/pi-mono), with an error brake.

This is a fork of [`Michaelliv/pi-goal`](https://github.com/Michaelliv/pi-goal) 0.1.7 (MIT). It keeps the upstream
behaviour and adds the one thing upstream is missing: a goal that stops itself when the provider fails.

## Why this fork exists

Upstream queues a continuation on every `agent_end`, without looking at how the turn ended. A provider that keeps
failing therefore produces an endless stream of paid calls that accomplish nothing. This was observed in production:
a 20-hour overnight run produced 11,370 failed turns and 11,376 goal continuations after the model endpoint went
down, with zero tool calls and zero work done. Upstream tracks this as
[issue #11](https://github.com/Michaelliv/pi-goal/issues/11).

## Differences from upstream

1. **Continuation is planned after `agent_settled`, not on `agent_end`.** Pi gets to finish its own retry and
   compaction recovery first. A failed turn no longer triggers an immediate second attempt.
   Pattern taken from [`patlux/pi-goal`](https://github.com/patlux/pi-goal).
2. **Error brake.** A failed turn is classified and counted. The goal waits with an exponential backoff and pauses
   with a reason once the configured threshold is reached. Classification, retry windows and pause rules follow
   [`manthedan/pi-goal`](https://github.com/manthedan/pi-goal) (MIT).
3. **Error classes.** `connection`, `rate_limit`, `token_exhausted`, `quota` and `other` are told apart. A context
   overflow and an exhausted provider quota pause immediately, a connection error is retried with a backoff.
4. **Configuration.** Thresholds and wait times come from `~/.pi/agent/pi-goal-brake.json` instead of being hardcoded.
5. **Observable state.** The goal state carries the error count, the last error class and the pause reason, and
   `/goal status` shows them.

## Install

```bash
pi install git:github.com/seladi81/pi-goal-brake@v1
```

## Configuration

Create `~/.pi/agent/pi-goal-brake.json`. Every key is optional, the values below are the defaults.

```json
{
  "maxConsecutiveErrors": 5,
  "backoffSeconds": [5, 15, 60, 300],
  "maxBackoffSeconds": 300,
  "pauseOnTokenExhausted": true
}
```

| Key | Meaning |
| --- | --- |
| `maxConsecutiveErrors` | Consecutive failed turns the goal tolerates before it pauses itself |
| `backoffSeconds` | Wait time per consecutive error, first entry for the first error |
| `maxBackoffSeconds` | Upper bound for the wait time |
| `pauseOnTokenExhausted` | Pause instead of retrying after a context overflow |

The file is read on every decision, so a change takes effect without a reload. The path can be overridden with the
environment variable `PI_GOAL_BRAKE_CONFIG`.

## Behaviour after a failed turn

```text
turn fails
  -> classify the error
  -> count it (same error signature counts, a new signature restarts the count)
  -> context overflow or exhausted quota: pause with reason
  -> threshold reached: pause with reason
  -> otherwise: wait the backoff time, then continue
```

A successful turn resets the counter.

## Usage

```text
/goal improve benchmark coverage until the suite has strong evidence
/goal --tokens 50k finish the migration and verify tests
/goal
/goal status
/goal pause
/goal resume
/goal clear
/goal statusbar off
```

When a goal is active, the extension shows compact visible lifecycle markers like `Goal active` and `Goal
continuing`; expand them with `ctrl+o` to inspect the objective and usage. The full continuation instructions ride
along as the content of that custom message, so the model always has the objective and audit guidance in the
transcript while the renderer keeps the visible UI compact.

The same Pi agent keeps running normal turns in the same session context until it calls
`update_goal({ status: "complete" })`, the user pauses/clears it, the token budget is reached, or the error brake
pauses it. Reloading Pi pauses an active goal instead of silently resuming it; use `/goal resume` to continue.
The final turn is still accounted even when the model completes the goal mid-turn.

## What it adds

- `pi-goal-writer` skill: draft and review strong `/goal` objectives with evidence-based success criteria
- `/goal [--tokens 50k] <objective>`: set or replace a goal
- `/goal` or `/goal status`: show the current goal, the error count and the pause reason
- `/goal pause`: stop autonomous continuation without deleting the goal
- `/goal resume`: reactivate a paused goal and reset the error counter
- `/goal clear`: remove the goal
- `/goal statusbar on|off`: show or hide the footer status line
- `create_goal` tool: model can set or replace the current goal only when explicitly requested
- `get_goal` tool: read current goal state
- `update_goal` tool: model can only mark the goal `complete`
- `get_goal` and `update_goal` are only exposed to the model while a goal is `active`
- footer status: `Pursuing goal`, `Goal paused`, `Goal achieved`, or `Goal unmet`

## State

Goal state is stored as Pi custom session entries with `customType: "pi-goal"`, the same format upstream uses, so
sessions stay readable across both versions. It follows the active session branch, survives reloads, and does not
require an external database.

## Development

```bash
npm install
npm test
npm run check
```

## License

MIT. Upstream copyright (c) 2026 Michael Livshits is preserved in `LICENSE`. The error brake follows ideas from
`manthedan/pi-goal` and `patlux/pi-goal`, both MIT.
