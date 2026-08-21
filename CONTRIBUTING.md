# Contributing to Hypermaker

Hypermaker is experimental. Small, focused changes are easiest to review.

## Before coding

1. Read [`AGENTS.md`](AGENTS.md).
2. Read [`docs/design.md`](docs/design.md) and [`docs/impl.md`](docs/impl.md).
3. Confirm the behavior belongs in the current scope.

## Local loop

```bash
npm install
npm test
npm run dev
npm run test:e2e
```

Use Node.js 20+. Keep generated text plain UTF-8. Do not commit `dev.log`, `.hypermaker/`, dependency directories, or generated test output.

## Change rules

- Keep the harness generic; put type/method behavior in `types/`.
- Preserve user intent when assembling prompts.
- Keep scripts and artifacts inspectable.
- Update `docs/design.md` for product behavior and `docs/impl.md` for architecture.
- Add a focused regression test for behavior you change.
- Run `git diff --check` before opening a pull request.

## Pull requests

Explain what changed, how it was tested, and any environment limitation. Screenshots or a short recording help for canvas/UI changes.
