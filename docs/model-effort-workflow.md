# Model Effort Workflow

Use this workflow to recommend the lowest adequate Codex effort setting for
each repository task. This workflow governs the coding agent's effort setting;
it does not change MindTree's product-model configuration in `SPEC.md`.

## Capability boundary

The agent may assess and recommend effort but must not claim it changed the
active setting unless the current environment exposes an explicit control and
the change succeeds.

If the active setting is not visible, say it is unknown rather than guessing.
Available effort levels may vary by model and Codex surface.

## Top-line recommendation

Begin the first user-facing response to a new task with one concise line such
as:

> Effort recommendation: High — this task changes synthesis approval and data
> integrity boundaries.

Recommend the lowest adequate level for the current task. Reassess instead of
carrying a previous recommendation forward automatically. If a known active
setting is materially mismatched, pause at a safe boundary and ask the user to
change or explicitly retain it before substantive work continues.

## Effort guide

### Low

Use for precise, reversible, mechanical work:

- small copy or formatting edits;
- narrow documentation corrections;
- known-value configuration updates;
- established verification commands;
- simple file moves or renames.

### Medium

Use for normal scoped implementation with agreed requirements:

- a well-defined component or route;
- routine owner-scoped queries and established schema usage;
- deterministic tests for understood behavior;
- contained refactoring within existing patterns;
- debugging with a small reproducible search space.

Medium is the default for ordinary phase implementation after architecture and
scope are approved.

### High

Use when substantial judgment, synthesis, or investigation is required:

- product and phase debriefs;
- architecture or data-model design;
- synthesis lifecycle, citation, staleness, or approval changes;
- privacy, authentication, authorization, or security decisions;
- migrations or difficult-to-reverse changes;
- OpenAI integration, streaming, structured output, or web search;
- complex debugging across client, server, database, and provider boundaries;
- final review of consequential work.

### XHigh

Reserve for unusually ambiguous or consequential work with high rework cost:

- several interacting foundational uncertainties;
- intermittent failures remaining after normal investigation;
- security-critical design across multiple trust boundaries;
- a foundational approval or provenance decision constraining many later
  phases.

Do not recommend XHigh merely because a task is large. Break large but
straightforward work into smaller tasks first.

## When to reassess

Reassess when:

- the goal or scope changes materially;
- mechanical work exposes an architectural decision;
- debugging crosses systems or repeated attempts fail;
- secrets, private content, destructive operations, authentication, external
  calls, or production data enter scope;
- work moves from planning to implementation or from implementation to final
  review;
- deterministic provider fixtures move to approved live-model evaluation.

Recommend a switch only when the current effort is materially mismatched.

## Switching protocol

When a switch matters:

1. Pause at a safe boundary.
2. State the current setting if known.
3. Name the recommended setting.
4. Give one reason tied to risk or complexity.
5. Wait for the user to change or explicitly retain the setting.
6. Rebuild context if the switch requires a new session.

Never use higher effort as a substitute for clarifying the goal, reducing
scope, or creating a testable plan.
