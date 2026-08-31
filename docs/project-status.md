# Project status

## Classification

`useful`: a runnable, inspectable local application for composing generated artifacts.

## Evidence

- Product source of truth: [`design.md`](design.md).
- Implementation source of truth: [`impl.md`](impl.md).
- Automated checks: `npm test`; browser checks: `npm run test:e2e`.
- Existing upstream: `https://github.com/ZisIsNotZis/hypermaker.git`.
- Existing dependency boundary: [`vendor/hyperframes`](../vendor/hyperframes) is a pinned Git submodule.

## Boundaries

The app is experimental, local-first, and depends on an authenticated Codex CLI for real generation. The repository does not claim hosted collaboration, production reliability, or benchmark results. No new video or paper is being created in this maintenance pass.

## Versioning

The current version is `0.1.0` in [`VERSION`](../VERSION). Update it with the changelog when a release changes the user-visible contract.
