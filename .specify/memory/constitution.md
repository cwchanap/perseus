<!--
=== Sync Impact Report ===
Version change: 0.0.0 → 1.0.0
Modified principles: N/A (initial constitution)
Added sections: Core Principles (4), Technology Constraints, Development Workflow, Governance
Removed sections: None
Templates requiring updates:
  - .specify/templates/plan-template.md ✅ (Constitution Check section compatible)
  - .specify/templates/spec-template.md ✅ (User stories + testing structure compatible)
  - .specify/templates/tasks-template.md ✅ (TDD workflow compatible)
  - .specify/templates/checklist-template.md ✅ (No changes needed)
Follow-up TODOs: None
========================
-->

# Perseus Constitution

## Core Principles

### I. Type Safety

All code MUST use strict TypeScript with full type coverage:

- No `any` types except in explicitly justified edge cases (documented inline)
- All function parameters and return types MUST be explicitly typed
- Shared types live in `src/lib/types/` (web) or dedicated type files
- Generic types preferred over type assertions
- `unknown` over `any` when type is truly unknown

**Rationale**: Type safety prevents runtime errors, enables confident refactoring, and serves as
living documentation.

### II. Test-First Development (NON-NEGOTIABLE)

TDD cycle MUST be followed for all feature work:

1. Write tests that describe expected behavior
2. Verify tests FAIL (red)
3. Implement minimum code to pass tests (green)
4. Refactor while keeping tests green

Test requirements:

- Unit tests for all services, utilities, and complex logic
- Component tests for Svelte components with user interactions
- E2E tests for critical user journeys
- Tests MUST run in CI before merge

**Rationale**: TDD ensures code correctness, drives better design, and provides regression safety.

### III. Component-Based Architecture

UI code MUST follow component-based principles:

- Components are self-contained with clear inputs (props) and outputs (events)
- Shared components live in `src/lib/components/`
- Page-specific components live alongside their routes
- Components MUST NOT directly access global state; use props or stores
- Favor composition over inheritance

**Rationale**: Isolated components are easier to test, reuse, and maintain.

### IV. Simplicity (YAGNI)

All implementations MUST follow minimum viable complexity:

- Implement only what is explicitly required
- No speculative features or "just in case" abstractions
- Three similar instances before extracting a pattern
- Choose boring technology over novel solutions
- Delete code rather than comment it out

**Rationale**: Simpler code is easier to understand, debug, and modify.

## Technology Constraints

### Static Export Requirement

The web application (`@perseus/web`) MUST remain statically exportable:

- No server-side rendering (SSR) dependencies
- No server-only load functions (`+page.server.ts` with non-prerenderable data)
- All data fetching happens client-side or at build time
- Adapter: `@sveltejs/adapter-static`

**Verification**: `bun run build` MUST succeed without SSR-related errors.

### Stack Boundaries

- **Web**: SvelteKit 2, Svelte 5, Tailwind CSS v4, TypeScript
- **API**: Hono, Bun runtime, TypeScript
- **Testing**: Vitest (unit/component), Playwright (E2E)
- **Package Manager**: Bun (monorepo workspaces)

## Development Workflow

### Code Quality Gates

Before any PR merge:

1. `bun run check` - TypeScript type checking passes
2. `bun run lint` - ESLint and Prettier checks pass
3. `bun run test:unit` - All unit tests pass
4. `bun run build` - Production build succeeds

### Commit Standards

- Commits SHOULD be atomic (one logical change per commit)
- Commit messages follow conventional commits format: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

## Governance

This constitution supersedes all other development practices in this repository.

**Amendments**:

- Proposed changes MUST be documented with rationale
- Changes require version bump following semver (MAJOR for principle changes, MINOR for additions,
  PATCH for clarifications)
- All existing code SHOULD be migrated to comply with amended principles

**Compliance**:

- All PRs MUST verify compliance with constitution principles
- Violations require explicit justification in PR description
- Constitution Check in plan.md MUST pass before implementation

**Version**: 1.0.0 | **Ratified**: 2025-12-14 | **Last Amended**: 2025-12-14
