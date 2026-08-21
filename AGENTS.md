Keep text artifacts plain UTF-8.

# Hypermaker agent guide

Hypermaker is a local-first, node-based artifact orchestration app. Product behavior lives in `docs/design.md`; implementation architecture lives in `docs/impl.md`. Read both before changing behavior. Do not add implementation caveats to the design doc.

## Working rules

- Inspect the real flow before editing. Prefer the smallest change that works.
- Keep the harness generic. Put output-type and generation-method behavior under `types/`.
- Preserve user intent in prompts and generated artifacts.
- Generated text must be plain UTF-8. Generated nodes always have `AGENTS.md`; leave it empty when no reusable memory matters.
- Codex runs from the repository root so `.agents` skills load automatically. Generated writes stay inside the current node directory.
- Validate behavior with `npm test`; for UI changes also run `npm run test:e2e` when browser execution is available.
- Keep `dev.log` and `.hypermaker/` untracked.

## Repository map

- `server/index.mjs`: local HTTP/SSE harness and Codex adapter.
- `public/index.html`: canvas UI.
- `types/`: filesystem registry for types and methods.
- `test/`: harness and browser tests.
- `docs/design.md`, `docs/impl.md`: only project source of truth.

For agent-document writing conventions, see `.agents/skills/writing-for-agents/SKILL.md` when modifying this file or adding agent instructions.
