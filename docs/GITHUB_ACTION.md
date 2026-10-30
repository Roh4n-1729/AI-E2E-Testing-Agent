# Using ai-e2e-agent in another repo's CI

The repo root is a GitHub Action (`action.yml`). A committed suite replays with plain Playwright (no AI, no API key);
pass/fail is decided from browser evidence; the job fails when a test fails; the HTML report is uploaded and a
summary table appears on the job page.

```yaml
name: e2e
on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # start your app (or test a preview deployment URL instead)
      - run: npm ci && npm run build && (npm start &) && npx wait-on http://localhost:3000
      - uses: Roh4n-1729/AI-E2E-Testing-Agent@main
        with:
          url: http://localhost:3000
          suite: tests/e2e/app.suite.json # written in the UI or with `aie2e export <runId>`
          baselines-dir: tests/visual-baselines # optional: approved screenshots committed with the code
          visual: fail # a screenshot that differs from its baseline fails the PR
          theme-from: https://design.example.com # optional: are we on the shared theme?
        env:
          # only needed when a test has no recorded steps yet, or with heal: 'true'
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # only for login-url
          AIE2E_USERNAME: ${{ secrets.E2E_USERNAME }}
          AIE2E_PASSWORD: ${{ secrets.E2E_PASSWORD }}
```

| Input                | Default | Meaning                                                                    |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `url`                | –       | The app to test                                                            |
| `suite`              | –       | Suite JSON path in your repo; empty = the AI plans tests (needs a key)     |
| `heal`               | `false` | `true` lets the agent heal a broken replay step (needs a key)              |
| `quality`            | `warn`  | Web Vitals, accessibility, theme: `off` / `warn` / `fail`                  |
| `visual`             | `warn`  | Screenshot comparison: `off` / `warn` / `fail`                             |
| `baselines-dir`      | –       | Folder of approved screenshots in your repo                                |
| `theme-from`         | –       | Check the theme against another product                                    |
| `login-url`          | –       | Log in first; credentials from `AIE2E_USERNAME` / `AIE2E_PASSWORD` secrets |
| `login-success-text` | –       | Text that proves the login worked                                          |
| `concurrency`        | `3`     | Tests in parallel                                                          |

Outputs: `passed`, `failed`, `report` (path of the HTML report).

Inputs are passed to the script as environment variables, never pasted into it, so a suite path or URL cannot
inject shell commands.
