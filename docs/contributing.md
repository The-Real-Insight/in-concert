# Contributing

**Powered by The Real Insight GmbH BPMN Engine ([the-real-insight.com](https://the-real-insight.com)).**

Thank you for your interest in **tri-bpmn-engine**. Community contributions help harden BPMN execution, documentation, and tooling.

## Ways to contribute

- **Report issues** — unexpected token flow, wrong gateway behavior, documentation gaps, or flaky tests. Include minimal BPMN (or a reference to `test/bpmn/...`), expected vs actual behavior, and your Node/Mongo versions.  
- **Suggest improvements** — open a discussion or issue before very large changes so maintainers can align on scope.  
- **Submit pull requests** — bug fixes, tests, docs, and small features are welcome. Match existing **TypeScript** style and keep diffs focused.

## Development workflow

1. Fork and clone the repository (or use a branch on your org’s fork).  
2. `npm install` and copy `.env.example` → `.env`.  
3. Run **`npm run test:unit`** frequently; run **`npm run test:sdk`** / **`npm run test:conformance`** when your change touches runtime or persistence.  
4. Open a PR with a clear description: **what** changed, **why**, and how you **verified** it (commands run).

## Code and documentation standards

- Prefer extending existing helpers over duplicating BPMN or Mongo logic.  
- Public behavior should be covered by tests when practical.  
- User-facing documentation belongs under **`docs/`**; link new pages from [docs/README.md](README.md).  
- Deep design specs may still live under **`readme/`** (requirements, implementation notes).  
- Do **not** remove or bypass **license attribution** (`LICENSE`, `src/attribution.ts`, and the “Powered by …” notice in README / docs). Changes here have legal effect; discuss with maintainers first.

## Publishing

The repository may use CI to publish **`@the-real-insight/tri-bpmn-engine`** to npm (see root **README** and `.github/workflows/`). Release mechanics are maintained by project owners; contributors normally do not need publish tokens.

## Code of conduct

Be respectful and constructive in issues and reviews. If the project adopts a formal **Code of Conduct** later, it will be linked from this file and the root README.

## Questions?

Open an issue or refer to [Documentation](README.md) for SDK usage, the browser demo, and testing.
