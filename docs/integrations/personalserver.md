# Integration: PersonalServer

PersonalServer is a C#/.NET stdio MCP server, exclusively for Claude clients. It is the first
programmatic consumer of Scroll's `ide-es`.

## What PersonalServer does

It **seeds an ide-es schema** and receives a spawned endpoint. It never runs the editor and never
grades. Concretely, a PersonalServer MCP tool:

1. Builds the ide-es schema: goal condition, problem, test-case + TLE budget, hints.
2. Calls Scroll's spawner (`create_ide_es` / sl) with `programmatic` config on.
3. Returns the spawned endpoint URL (and staged hints) to Claude, which hands it to the user in
   conversation.

Claude in conversation is the only intelligence on this path. Scroll hosts the IDE and runs the
grader; the submission resolves only when the hidden tests pass within the TLE / complexity budget.

## Config: programmatic on

`programmatic: on` means the endpoint is bare seed-and-grade: no coaching layer, no live AI inside
Scroll. This is the PersonalServer path. The `programmatic: off` (AI-enhanced) path belongs to
STARfolio, see [starfolio.md](starfolio.md).

## Grading trust (the problem-source decision)

The graded oracle (hidden tests, reference solution, TLE budget) lives in Scroll, because that is the
only place grading can be trustworthy. Claude can **propose** problems that get vetted into a bank,
but an unvetted AI-authored oracle must never block a real submission. Open item, see
[open-questions.md](../open-questions.md).

## Boundary discipline

The ide-es schema is the contract between PersonalServer and Scroll, the same discipline
PersonalServer used for the STARfolio config handshake: neither side changes the schema alone. Keep
PersonalServer's side thin (one tool that seeds and returns a URL) and Claude-only; do not put a code
sandbox in the C# server. Untrusted-code execution stays in Scroll.

## Availability

When Scroll is not running, the seeding tool returns a clean error rather than throwing over stdio,
matching PersonalServer's existing degradation pattern for absent external services.
