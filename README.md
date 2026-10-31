# Riff

Invent your next live experience together.

This repository contains the development foundation for the approved Riff product: six TypeScript workspaces, installed dependencies, a local Fastify service, SQLite migrations, and separate console, overlay, and OBS dock entries. The complete F01–F40 scope remains in the [product documentation](docs/project-documentation.md).

Live compilation, Twitch authentication, generated-code execution, effects, approval, and collaboration are **not implemented yet**. The interface identifies this state explicitly. No credentials are needed to start the foundation.

## Start here

Run from this `riff` directory:

```sh
# This checkout already has local Node/pnpm support and dependencies installed.
./scripts/pnpm db:migrate
./scripts/pnpm dev
```

Open the console at <http://localhost:5173>, the inactive transparent overlay at <http://localhost:5173/overlay/>, or the dock at <http://localhost:5173/dock/>. Host health is at <http://127.0.0.1:8787/api/health>.

For a fresh checkout, install Node from `.nvmrc`, enable Corepack, and install the frozen lockfile first. See [setup instructions and environment requirements](docs/setup.md). Copy `.env.example` to `.env` only when changing defaults.

## Workspace

```text
apps/
  server/               Trusted HTTP host, services, adapters, workers, database
  web/                  Console, overlay, dock, shared UI, effects, locales
packages/
  sdk/                  Dependency-free capability contract and policy constants
  compiler/             Compilation contracts and validation pipeline ownership
  sandbox/              QuickJS host and capability bridge ownership
  twitch/               OAuth, EventSub, Helix and fixture ownership
config/                 Workspace dependency graph and external tool inventory
scripts/                Toolchain wrapper, checks, smoke test and tooling tests
infra/                  Containers, local proxy, monitoring, backup/isolation plans
docs/                   Product, technology, setup, decisions and implementation plans
data/                   Ignored local SQLite files
```

Responsibility READMEs reserve the full product structure without introducing unused classes or pretending product features exist. Browser code communicates through HTTP/WS; it cannot import server packages. The server composes the four packages, compiler/sandbox depend only on the SDK internally, and the SDK has no runtime dependencies.

## Common commands

Use `./scripts/pnpm` in this checkout, or `pnpm` after activating the pinned toolchain.

| Command                           | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `./scripts/pnpm run doctor`       | Required tools, conditional tool availability and dependency presence    |
| `./scripts/pnpm dev`              | Server watch mode and Vite hot reload                                    |
| `./scripts/pnpm check`            | Lint, package boundaries, types, host/tooling tests, focused secret scan |
| `./scripts/pnpm format:check`     | Formatting check                                                         |
| `./scripts/pnpm build`            | Build the packages, server and three browser entries                     |
| `./scripts/pnpm check:bundles`    | Verify separate entries and inactive overlay isolation after build       |
| `./scripts/pnpm smoke`            | Exercise Fastify and real SQLite through in-process HTTP injection       |
| `./scripts/pnpm db:generate`      | Generate a migration after an intentional schema change                  |
| `./scripts/pnpm db:migrate`       | Apply committed migrations to the configured database                    |
| `./scripts/pnpm browsers:install` | Install the Chromium version required by Playwright                      |
| `./scripts/pnpm test:e2e`         | Browser and axe accessibility checks; needs local sockets                |
| `./scripts/pnpm security:audit`   | Query npm advisories for production dependencies                         |
| `./scripts/pnpm security:secrets` | Gitleaks history scan; requires its CLI                                  |
| `./scripts/pnpm setup:verify`     | Full foundation verification, including browsers                         |

`doctor` is also a pnpm built-in; include **`run`** to select Riff's script.

After `build`, `./scripts/pnpm start` serves the compiled interface and API together on port 8787. This remains a local foundation with no authentication or active automation routes.

## Engineering practices

- Central dependency catalog and lockfile; shared TypeScript, ESLint, formatting and test configuration.
- Strict source types, runtime validation at input boundaries, injected dependencies and explicit resource disposal.
- Tested package boundaries and a dependency-free SDK; external I/O belongs to the trusted host or Twitch package.
- Shared console/dock presentation with a separate overlay build. Reuse follows actual shared behavior.
- Host tests run under Vitest; generated automation fixtures are excluded. QuickJS loading is tested, but guest isolation is not implemented or certified.
- GitHub Actions runs the checks without live integration credentials. No publish or deployment workflow is enabled.

Read [AGENTS.md](AGENTS.md) for the engineering contract, [tech-stack.md](docs/tech-stack.md) for technology ownership, and [setup-status.md](docs/setup-status.md) for verified results and remaining environment requirements.
