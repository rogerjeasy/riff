# Project Foundation Implementation Plan

> **For agentic workers:** Use the executing-plans workflow to implement the tasks below in this session. The user has authorized scaffolding and installation from the approved technology stack.

**Goal:** Establish the complete workspace layout, install available required dependencies, and provide a verified development foundation with clear reports for environment-blocked tools.

**Architecture:** Keep the six approved workspaces. Centralize dependency versions, strict TypeScript configuration, linting, testing, and scripts. Create minimal runnable server and separate console/overlay/dock entries; product integrations remain explicitly inactive until their implementations and credentials exist.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript 5, React 19, Vite, Tailwind 4, Fastify 5, SQLite/Drizzle, Zod, QuickJS, runtime compiler SDK, Vitest, Playwright, and the supporting tools in the inventory.

**Spec:** [Technology stack](../../tech-stack.md), [product requirements](../../project-documentation.md), and [engineering contract](../../../AGENTS.md).

## Global Constraints

- Preserve the six workspace dependency directions; SDK has zero runtime dependencies.
- No generated automation may execute through host Node, Vitest, or the browser.
- Keep all runtime functionality requiring Twitch, model credentials, or OBS disabled in the foundation.
- TypeScript uses strict, noUncheckedIndexedAccess, and exactOptionalPropertyTypes.
- Centralize versions/configuration and introduce abstractions only where there is actual shared behavior.
- Work in the existing `riff` folder on `setup/project-foundation`; there was no existing Git repository or branch to isolate.
- Use neutral artifact names and focused conventional commits without AI attribution.
- Network/download or daemon restrictions must be reported accurately; never fabricate an install, lockfile, or test result.

## Review Focus

- A fresh checkout must distinguish missing tools from installed dependencies, and install commands must be reproducible.
- Malformed environment values and unsafe non-loopback startup must fail clearly; defaults require no external credentials.
- The database must migrate and persist on a real file, with connections closed during shutdown.
- The overlay bundle must not contain console code or expose active integration controls.
- Package-boundary enforcement must catch forbidden imports and SDK runtime dependencies, including workspace subpaths.

## Task 1: Workspace and toolchain

**Files:** Root package/workspace manifests, shared TypeScript/ESLint/Prettier/Vitest configuration, `.gitignore`, `.env.example`, `.node-version`, `.nvmrc`, `.npmrc`, six package manifests and TypeScript configs, `scripts/` tooling, local ignored tool directory.

**Interfaces:** Workspace package names are `@riff/web`, `@riff/server`, `@riff/sdk`, `@riff/compiler`, `@riff/sandbox`, and `@riff/twitch`. A single version catalog owns shared direct dependency versions. Root commands own build, check, tests, database, browser installation, and tool inspection.

- [ ] Record the available toolchain and installation restrictions; use existing Node 22 and cached pnpm when possible.
- [ ] Define workspace manifests, exact compatible dependencies, build allowlists, and shared checks.
- [ ] Install dependencies and native tooling from authorized sources/caches; preserve the resulting real lockfile.
- [ ] Verify each workspace resolves only its declared dependencies and record any unavailable packages.
- [ ] Commit the workspace foundation separately from application code.

## Task 2: Host and package foundations

**Files:** `apps/server/src/{env.ts,app.ts,index.ts,log.ts,db/,routes/,services/}`, `apps/server/test/`, `apps/server/drizzle/`, package `src/index.ts` entrypoints, package test folders.

**Interfaces:** `parseEnv(input)` returns validated local configuration; `createApp(deps)` creates a Fastify instance without listening; `openDatabase(path)` returns the SQLite/Drizzle connection with explicit close; `/api/health` reports only foundation readiness. SDK exports version/policy types without runtime dependencies. No guest evaluator is exported.

- [ ] Write environment, real-file database/migration, and health-route tests, and run them before implementation.
- [ ] Implement environment parsing, redacted logging, dependency injection, database setup, health route, and graceful shutdown.
- [ ] Add minimal typed package entrypoints and responsibility documentation; unsupported functionality remains unavailable.
- [ ] Run focused tests, workspace checks, and production build.
- [ ] Commit the host/package foundation with its tests.

## Task 3: Browser foundations

**Files:** `apps/web/{index.html,overlay/index.html,dock/index.html,vite.config.ts}`, `apps/web/src/{console/,overlay/,dock/,components/,lib/,styles/}`, `apps/web/e2e/`, Playwright configuration.

**Interfaces:** Three separate HTML entries share only intentional design tokens/components. Console and dock show foundation status; the overlay is transparent and inactive. Typed HTTP boundary validation is browser-local.

- [ ] Add browser checks for console/dock rendering, transparent overlay, and absence of active connection/approval controls.
- [ ] Implement accessible minimal entrypoints and shared presentation primitives.
- [ ] Configure Vite proxy, manifest output, separate entries, and Tailwind integration.
- [ ] Install browser binaries if available, run browser checks, and verify built entry separation.
- [ ] Commit the browser foundation separately.

## Task 4: Delivery, operations, and architecture guardrails

**Files:** `infra/{containers/,monitoring/,proxy/,backups/}`, `.github/workflows/`, `scripts/`, architecture checks/tests, `README.md`, `docs/setup.md`, dependency/tool status documentation.

**Interfaces:** Default development starts only the local server and web UI. Optional Compose profiles describe monitoring/proxy tooling without exposing public services. Doctor/setup reporting distinguishes installed, configured, conditional, and blocked tools.

- [ ] Write and verify boundary-check failure cases, then implement the reusable checker.
- [ ] Add container and optional operations configuration, CI, secret/dependency checks, and setup/doctor commands.
- [ ] Document actual installation results, environment requirements, all directories, and exact startup commands.
- [ ] Reconcile relevant engineering-contract clarifications and update implementation status in both product documents.
- [ ] Run lint, typecheck, tests, build, smoke, browser checks, and available security checks; record unavailable checks explicitly.
- [ ] Obtain a fresh whole-change review, fix material findings, rerun affected/full checks, and commit focused delivery/documentation groups.

## Execution notes

- Initial inspection: documentation only, no repository, no packages. Active shell Node is 24; Node 22.23.2 exists locally. Cached pnpm 12.6.0 exists. Terminal registry DNS fails; Docker CLI exists but daemon access is denied and Compose is absent. These observations guide installation attempts, not assumptions about completion.
