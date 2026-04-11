# Contributing to in-concert

**Powered by The Real Insight GmbH BPMN Engine ([the-real-insight.com](https://the-real-insight.com)).**

Thank you for your interest in **in-concert** (`@the-real-insight/in-concert`). Community contributions help harden BPMN execution, documentation, and tooling.

## Ways to contribute

- **Report bugs** — unexpected token flow, wrong gateway behavior, flaky tests. Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).
- **Request features** — open a [feature request](.github/ISSUE_TEMPLATE/feature_request.md) or discussion before large changes so maintainers can align on scope.
- **Submit pull requests** — bug fixes, tests, docs, and small features are welcome. Match existing TypeScript style and keep diffs focused.
- **Good first issues** — look for issues labelled [`good first issue`](https://github.com/The-Real-Insight/in-concert/labels/good%20first%20issue).

## Local setup

```bash
git clone https://github.com/The-Real-Insight/in-concert.git
cd in-concert
npm install
cp .env.example .env      # set MONGO_URL if needed
```

Start MongoDB locally (or point `MONGO_URL` at an existing instance), then:

```bash
npm run dev               # start the engine in watch mode
```

## Test commands

```bash
npm run test:unit          # fast unit tests — run these often
npm run test:conformance   # BPMN conformance suite
npm run test:sdk           # SDK integration tests (requires running engine + Mongo)
npm run test:worklist      # worklist tests
npm run test:callback      # full callback-demo suite
```

Run `npm run test:unit` frequently during development. Run the broader suites before opening a PR.

## Pull request process

1. Fork the repo and create a branch (`git checkout -b fix/my-fix` or `feat/my-feature`).
2. Make your changes and ensure all relevant test suites pass.
3. Open a PR with a clear description: **what** changed, **why**, and how you **verified** it.
4. A maintainer will review and merge when ready.

## Code and documentation standards

- Keep TypeScript types explicit — avoid `any` unless unavoidable.
- Prefer extending existing helpers over duplicating BPMN or Mongo logic.
- Public behavior should be covered by tests where practical.
- User-facing documentation belongs under `docs/`; link new pages from [docs/README.md](docs/README.md).
- Do **not** remove or bypass license attribution (`LICENSE`, `src/attribution.ts`, or the "Powered by …" notice in docs). These have legal effect — discuss with maintainers before touching them.

## Commit messages

Use a short imperative subject line. If the change is non-trivial, add a blank line and a paragraph explaining *why*. No ticket references required.

## Publishing

CI publishes `@the-real-insight/in-concert` to npm automatically on push to `main`. Contributors do not need npm publish tokens.

## Code of conduct

Be respectful and constructive in issues and reviews. Harassment or abusive language will not be tolerated.

## Questions?

Open an issue or refer to the [documentation](docs/README.md) for SDK usage, testing, and architecture details.
