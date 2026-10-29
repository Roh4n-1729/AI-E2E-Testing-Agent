# buggy-shop: the seeded-bug app

A tiny shop with **known, switchable bugs**, used to measure what the tester catches and how often it
raises false alarms. It has no dependencies, so it runs anywhere Node runs.

```bash
npm run shop                                   # all bugs on, http://localhost:4300
BUGS=none npm run shop                         # the clean app
BUGS=wrong-total,dead-button npm run shop      # only these bugs
HINTS=1 npm run shop                           # with data-testid / aria-busy hints
```

| Bug (`bugs.json`) | What is wrong                                                  |
| ----------------- | -------------------------------------------------------------- |
| `dead-button`     | "Add to cart" on the Notebook does nothing                     |
| `wrong-total`     | The cart total ignores quantities                              |
| `fake-subscribe`  | The newsletter shows "Subscribed" although the API returns 500 |
| `no-validation`   | Checkout accepts an empty email and places the order           |
| `console-error`   | The cart page throws a JavaScript error on load                |
| `missing-alt`     | Product images have no alt text                                |
| `slow-search`     | The search API takes 3.5 s                                     |

`suite.json` is a committed test suite for the shop: 7 tests, 5 of them with recorded steps, so it runs with
no LLM at all:

```bash
aie2e run http://localhost:4300 --suite examples/buggy-shop/suite.json --no-heal
```

`npm run eval` runs the clean app several times and then every bug on its own, and writes
`docs/EVALUATION.md`. `npm run eval -- --mode explore --heal` lets the AI explore and plan its own tests
instead of using the suite (needs an API key).
