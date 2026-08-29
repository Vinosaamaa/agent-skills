# Agent Instructions

- Keep each reusable skill under `skills/<skill-name>/` with its own instructions, implementation, fixtures, tests, and benchmarks.
- Use generated fixtures only; never commit real transcripts, review artifacts, credentials, machine state, or private project data.
- Keep skills independently installable and testable without a repository-wide framework.
- Run `npm run validate`, `npm test`, and `npm run benchmark` before publication.
- Keep repository changes scoped to an owning issue and avoid speculative skill placeholders.
