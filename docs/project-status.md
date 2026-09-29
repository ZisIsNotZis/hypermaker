# Project status

## Classification

`useful` (closed milestone): a runnable, inspectable local application for composing generated artifacts.

## Status

Closed as a milestone (2026-09-29). The app reached its experimental goal; no
active development is planned unless the project's inputs or goals change.

## Evidence

- Product source of truth: [`design.md`](design.md).
- Implementation source of truth: [`impl.md`](impl.md).
- Automated checks: `npm test`; browser checks: `npm run test:e2e`.
- Existing upstream: `https://github.com/ZisIsNotZis/hypermaker.git`.
- Existing dependency boundary: [`vendor/hyperframes`](../vendor/hyperframes) is a pinned Git submodule.

## Boundaries

The app is local-first and depends on an authenticated Codex CLI for real
generation. It does not claim hosted collaboration or production reliability.

## Deferred

No benchmark results, video, or paper were produced; these remain out of scope.

## Versioning

The current version is `0.1.0` in [`VERSION`](../VERSION). Update it with the changelog when a release changes the user-visible contract.
