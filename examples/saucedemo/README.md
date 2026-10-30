# saucedemo: a real app whose bugs depend on who logs in

Sauce Labs' demo shop "Swag Labs" ([saucelabs/sample-app-web](https://github.com/saucelabs/sample-app-web),
MIT, licence in `app/LICENSE`), built from the unmodified source and served locally: no internet, no API key,
and no tokens spent by the app itself. Its bugs are built in and switched by the user you log in as. Every
user's password is `secret_sauce`, printed on the app's own login page.

```bash
npm run saucedemo                         # http://localhost:4500
# .env (or the shell):  AIE2E_USERNAME=standard_user  AIE2E_PASSWORD=secret_sauce
npm start -- run http://localhost:4500 --suite examples/saucedemo/suite.json --no-heal
```

Record and approve the screenshots as `standard_user` first, then switch `AIE2E_USERNAME` and run the same
suite again. Replays cost 0 tokens. Measured on Fri 30 Oct:

| User                      | Result                  | Caught by                                                                     |
| ------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `standard_user`           | 6/6 pass                | (approves the baselines)                                                      |
| `problem_user`            | 5 of 6 fail             | wrong photos, sort ignored, remove broken, last name broken; visual diffs     |
| `error_user`              | 4 of 6 fail             | the app's own JavaScript errors (sort, remove, last name, finish)             |
| `visual_user`             | 2 of 6 fail             | wrong first photo, random prices; screenshots differ on every screen          |
| `performance_glitch_user` | 6/6 pass, with warnings | Web Vitals: LCP about 6 s against a 4 s budget (slow, not broken)             |
| `locked_out_user`         | the run stops at login  | login check: "expected the URL to contain /inventory.html", with a screenshot |

## Declared noise

The suite's `ignore` block lists third-party noise this app makes on every page, so it never fails a test:
Google Fonts (blocked offline), the Backtrace error reporter (`events.backtrace.io`, configured with a placeholder
token upstream), and the Backtrace SDK's deprecated `unload` handler ("Permissions policy violation: unload").
The requests still show in each test's evidence. Nothing about the app's own code is ignored: `error_user`'s
JavaScript errors still fail tests.
