# Testing

This document covers FlowStar's test setup, how to run each suite, and — most
importantly — how Playwright visual snapshot baselines are managed.

---

## Test suites at a glance

| Suite | Runner | Command |
|---|---|---|
| Unit tests | Vitest | `npm test` |
| E2E / visual | Playwright | `npm run test:e2e` |
| Contract tests | Rust / `cargo test` | `cd contracts && cargo test` |

---

## Unit tests (Vitest)

```bash
npm test          # single run
npm run test:watch  # watch mode
```

Tests live in `lib/__tests__/` and cover unlock math, formatters, and utility
functions.

---

## E2E tests (Playwright)

### Running locally

Start the dev server in one terminal, then run Playwright in another:

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run test:e2e
```

Or build and serve in mock mode (no contract needed), which is what CI does:

```bash
npm run build   # no contract env vars needed — falls back to mock mode
npm run start &
npm run test:e2e
```

### Visual snapshot tests

Playwright uses pixel-diff screenshots to catch unintended UI regressions.
Baseline PNG files live in `e2e/__screenshots__/`. When a test runs, Playwright
compares the current screenshot against the committed baseline. If no baseline
exists, the test **fails** (it has nothing to compare against).

---

## Playwright visual baselines

### How baselines are generated

Baselines must be generated on **Linux in CI**, not on your local machine. This
is because Playwright renders fonts and anti-aliasing slightly differently
across operating systems. A baseline generated on Windows or macOS will produce
false-positive diff failures when CI runs on `ubuntu-latest`, causing tests to
fail for everyone else even when no real UI change was made.

**Do not commit snapshot PNGs generated on Windows or macOS.**

### When to regenerate baselines

Regenerate baselines when you have intentionally changed the UI — for example:

- Updated a component's layout, colours, or typography
- Added a new visual test that has no existing baseline
- Changed global CSS that affects multiple pages

If you only changed non-visual logic (math, API calls, state), you should not
need to update baselines.

### How to run the workflow

Baselines are regenerated via the **Update Playwright Snapshots** GitHub Actions
workflow. To trigger it:

1. Go to the repository on GitHub.
2. Open **Actions → Update Playwright Snapshots**.
3. Click **Run workflow**.
4. In the **Branch to update snapshots on** field, enter the branch you are
   working on (leave blank to use the default branch).
5. Click **Run workflow** to confirm.

The workflow will:

1. Check out your branch on `ubuntu-latest`.
2. Install dependencies and Playwright browsers.
3. Build the app in mock mode.
4. Run `npx playwright test --update-snapshots` to regenerate all baseline PNGs.
5. Commit any new or changed files under `e2e/__screenshots__/` back to your
   branch with the message `test: update playwright visual snapshots [skip ci]`.

After the workflow completes, pull the changes locally:

```bash
git pull
```

CI will now use the freshly committed Linux baselines for comparison.

### CI behaviour

The CI `e2e` job also runs with `--update-snapshots`. This means:

- If baseline PNGs are already committed, Playwright diffs against them normally.
- If a baseline is missing (e.g. you added a new visual test but haven't run
  the workflow yet), CI generates it in-place and commits it. The test does not
  fail on first run; it establishes the baseline so the *next* run can diff.

This means CI will never go red solely because a baseline PNG is missing — but
it also means any newly generated baseline in CI reflects Linux rendering, which
is correct and intentional.

### Summary of rules

| Situation | What to do |
|---|---|
| Intentional UI change on your branch | Trigger **Update Playwright Snapshots** workflow on your branch |
| New visual test with no baseline | Trigger the workflow, or let CI generate it on first run |
| Baseline generated on Windows / macOS | **Do not commit it** — trigger the workflow instead |
| Flaky diff on a pixel you didn't touch | Check if your branch has locally generated PNGs committed; replace via workflow |

---

## Contract tests (Rust)

```bash
cd contracts
cargo test
```

To run a single test:

```bash
cargo test test_withdraw_after_cliff
```

44 tests cover the full stream lifecycle, authorization, cliff edge cases,
overdraw protection, integer math, and self-streams. See
[CONTRACT_TESTING.md](./CONTRACT_TESTING.md) for details.
