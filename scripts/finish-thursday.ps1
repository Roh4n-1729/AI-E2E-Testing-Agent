<#
  Finishes the Thursday loose ends on a Windows machine, in a safe order:
    1. delete files that no longer belong to the project
    2. write .github/workflows/ci.yml
    3. npm install
    4. checks: types, lint, formatting, UI build, tests, evaluation (stops at the first failure)
    5. git init + a readable commit history grouped by area (only if checks passed)
    6. optional: push to GitHub         (-Remote https://github.com/<you>/ai-e2e-agent.git)
    7. optional: full-AI evaluation      (-AiEval; uses your API key and costs tokens)

  Usage, from the project folder:
    powershell -ExecutionPolicy Bypass -File scripts\finish-thursday.ps1
    powershell -ExecutionPolicy Bypass -File scripts\finish-thursday.ps1 -Remote https://github.com/you/ai-e2e-agent.git -AiEval
  Flags: -SkipTests skips `npm test` (about 5 minutes) when you have just run it yourself.
#>
param(
  [string]$Remote = '',
  [switch]$AiEval,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Say($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Run([string]$label, [scriptblock]$block) {
  Say $label
  & $block
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED: $label (exit code $LASTEXITCODE). Paste the output above to Claude." -ForegroundColor Red
    exit 1
  }
}

if (-not (Test-Path package.json) -or -not (Select-String -Path package.json -Pattern '"name": "ai-e2e-agent"' -Quiet)) {
  Write-Host 'Run this from the ai-e2e-agent project folder.' -ForegroundColor Red; exit 1
}

# ---- 1. cleanup --------------------------------------------------------------------------------------
Say 'Removing files that are no longer part of the project'
$obsolete = @(
  'tsconfig.json', 'tsconfig.build.json', 'src/core/graph.js', 'tests/graph.test.js',
  'ui/src/components/Layout.jsx', 'ui/src/components/ResultCard.jsx'
)
foreach ($f in $obsolete) {
  if (Test-Path $f) { Remove-Item $f -Force; Write-Host "  deleted $f" } else { Write-Host "  already gone: $f" }
}

# ---- 2. CI workflow (could not be written remotely) ------------------------------------------------
Say 'Writing .github/workflows/ci.yml'
$ci = @'
name: ci
on:
  push:
  pull_request:

jobs:
  check:
    name: lint, types, unit + integration tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run check
      - run: npm run lint
      - run: npm run format:check
      - run: npm run ui:build
      - run: npm test

  e2e-demo:
    # The product dogfooding itself in CI: a committed suite replays with no LLM and no API key.
    # The clean shop must pass; the same suite must catch a seeded regression (the job fails if it doesn't).
    name: committed suite against the seeded-bug shop
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: clean app passes
        run: |
          BUGS=none PORT=4300 node examples/buggy-shop/server.js &
          sleep 1
          node src/cli/main.js run http://localhost:4300 --suite examples/buggy-shop/suite.json --no-heal -c 3 -o .aie2e/clean
      - name: a seeded regression is caught
        run: |
          BUGS=wrong-total PORT=4301 node examples/buggy-shop/server.js &
          sleep 1
          if node src/cli/main.js run http://localhost:4301 --suite examples/buggy-shop/suite.json --no-heal -c 3 -o .aie2e/buggy; then
            echo "::error::the seeded bug was NOT detected"; exit 1
          fi
          echo "regression detected as expected"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: e2e-reports
          path: .aie2e/*/runs/*/
          retention-days: 7
'@
New-Item -ItemType Directory -Force -Path '.github/workflows' | Out-Null
# UTF-8 without BOM and LF line endings, like every other file in the repo
[IO.File]::WriteAllText((Join-Path (Get-Location) '.github/workflows/ci.yml'), ($ci -replace "`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))
Write-Host '  written'

# ---- 3. install + 4. checks --------------------------------------------------------------------------
Run 'npm install' { npm install }
Run 'Type check (tsc)' { npm run check }
Run 'Lint (eslint)' { npm run lint }
Run 'Formatting (prettier)' { npm run format:check }
Run 'UI build' { npm run ui:build }
if (-not $SkipTests) { Run 'Tests (unit + real-browser integration, ~5 min)' { npm test } }
Run 'Evaluation on the seeded-bug shop (no API key needed, ~5 min)' { npm run eval }

# ---- 5. git history ----------------------------------------------------------------------------------
Say 'Git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host 'git is not installed: https://git-scm.com/download/win' -ForegroundColor Red; exit 1 }
$name = git config user.name; $email = git config user.email
if (-not $name -or -not $email) {
  Write-Host 'Set your git identity first, then run this script again with -SkipTests:' -ForegroundColor Yellow
  Write-Host '  git config --global user.name  "Your Name"'
  Write-Host '  git config --global user.email "you@example.com"'
  exit 1
}

$trailer = @('-m', "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_01CWrZKCJcKDMCKek21cxtdw")
function Commit([string]$title, [string]$body, [string[]]$paths) {
  $existing = $paths | Where-Object { Test-Path $_ }
  if (-not $existing) { return }
  git add -- $existing
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) { return }   # nothing staged for this group
  git commit -q -m $title -m $body @trailer
  if ($LASTEXITCODE -ne 0) { Write-Host "git commit failed: $title" -ForegroundColor Red; exit 1 }
  Write-Host "  $title"
}

if (Test-Path .git) {
  Write-Host 'A git repository already exists here, so the grouped history is skipped.' -ForegroundColor Yellow
  Write-Host 'Commit any remaining changes yourself: git add -A; git commit -m "chore: sync"'
} else {
  git init -q -b main
  if ($LASTEXITCODE -ne 0) { git init -q; git checkout -q -b main }
  Write-Host '  repository created; committing by area:'

  Commit 'chore: project setup' 'Node 22 ESM project, JSDoc types checked by tsc, eslint, prettier, vitest; secrets and run output ignored.' @(
    'package.json', 'package-lock.json', '.gitignore', '.gitattributes', '.prettierrc.json', '.prettierignore',
    'eslint.config.js', 'jsconfig.json', 'vitest.config.js', '.env.example', 'src/types')
  Commit 'feat(core): types, ports, event bus and test runner' 'Typed data model, executor/judge/planner ports, run events consumed by CLI, reporters and UI, config with quality gate.' @(
    'src/core/types.js', 'src/core/ports.js', 'src/core/testRunner.js', 'src/events', 'src/util', 'src/config')
  Commit 'feat(browser): session, settle, evidence collectors, cursor and app hints' 'Waits until the page is quiet (text, aria-busy, in-flight requests); collects network, downloads, toasts, web vitals and axe results; optional data-testid / aria-busy / data-aie2e-* hints.' @(
    'src/browser', 'src/storage')
  Commit 'feat(plan): capped BFS crawler and grounded LLM planner' 'The planner only uses URLs, endpoints and test ids the crawl saw; committed suites plan without an LLM.' @(
    'src/crawler', 'src/planner', 'src/llm')
  Commit 'feat(executor): AI agent, record/replay and self-healing' 'Passing agent runs are recorded as JSON steps with stable selectors and replayed by Playwright with no LLM; a broken step hands over to the agent and the heal is logged.' @(
    'src/executor')
  Commit 'feat(judge): strict evidence judge' 'Never trusts a success claim; ignores checks already true at the start; asymmetric trust for failure claims; visual checks see a screenshot timeline.' @(
    'src/judge')
  Commit 'feat(theme): theme conformance of the production build' 'Discovers themes from the CSSOM, switches through them, and traces every off-theme value to its CSS declaration via CDP; detects dark-mode leaks.' @(
    'src/theme')
  Commit 'feat(orchestration): LangGraph pipeline with bounded fan-out' 'crawl -> plan -> one runTest branch per test (Send) -> writeReport; own limiter because maxConcurrency: 1 drops Send branches.' @(
    'src/core/pipeline.js', 'src/app', 'scripts/graph.js')
  Commit 'feat(cli,server): CLI, local server and reports' 'aie2e run / export / doctor / ui; Fastify server with SSE and CDP screencast; self-contained HTML report and JSON.' @(
    'src/cli', 'src/server', 'src/reporter')
  Commit 'feat(ui): web UI with live view, step timeline and dark mode' 'React 19, Tailwind v4 tokens, Radix UI; runs, recordings and hints pages; in-app screenshot viewer; theme tab.' @(
    'ui')
  Commit 'test: unit and real-browser integration tests' 'Judge rules, replay and heal, settle, hints, quality evidence, live view, theme audit and the LangGraph pipeline against real Chromium.' @(
    'tests')
  Commit 'feat(eval): seeded-bug shop and evaluation script' 'Ten switchable bugs (functional, error, accessibility, performance, theme); runs the clean app N times, then each bug alone.' @(
    'examples', 'scripts/evaluate.js', 'scripts/finish-thursday.ps1', 'scripts/finish-thursday.cmd')
  Commit 'ci: checks, tests and an end-to-end job against the seeded-bug shop' 'The clean shop must pass and a seeded regression must fail, using a committed suite with no API key.' @(
    '.github')
  Commit 'docs: README, architecture, roadmap, evaluation and study guide' 'Including the improvements log from real runs and an animated study guide.' @(
    'README.md', 'docs')

  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { git commit -q -m 'chore: remaining files' -m 'Files not covered by the groups above.' @trailer; Write-Host '  chore: remaining files' }
  Write-Host ''
  git log --oneline
}

# ---- 6. push -----------------------------------------------------------------------------------------
if ($Remote) {
  Say "Pushing to $Remote"
  $hasOrigin = (git remote) -contains 'origin'
  if ($hasOrigin) { git remote set-url origin $Remote } else { git remote add origin $Remote }
  git push -u origin main
  if ($LASTEXITCODE -ne 0) { Write-Host 'Push failed. Create the empty repository on github.com first (no README), then run: git push -u origin main' -ForegroundColor Red; exit 1 }
} else {
  Say 'Not pushed'
  Write-Host 'Create an EMPTY repository on github.com (no README or licence), then:'
  Write-Host '  git remote add origin https://github.com/<you>/ai-e2e-agent.git'
  Write-Host '  git push -u origin main'
}

# ---- 7. full-AI evaluation (optional, costs tokens) --------------------------------------------------
if ($AiEval) {
  Run 'Full-AI evaluation: the planner writes its own tests, the agent runs them (uses your API key)' {
    npm run eval '--' --mode explore --heal --runs 1 --report docs/EVALUATION_AI.md
  }
  git add docs/EVALUATION_AI.md
  git commit -q -m 'docs(eval): full-AI evaluation results' -m 'Planner + agent + healing on the seeded-bug shop.' @trailer
  Write-Host 'Wrote docs/EVALUATION_AI.md and committed it. Push again to publish: git push'
}

Say 'Thursday is finished.'
Write-Host 'Next: npm run ui  ->  run your Presentation Builder in light and dark, and paste the report to Claude.'
