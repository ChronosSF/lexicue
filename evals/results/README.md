# Eval results

One folder per run, named `<timestamp>-<label>`, each holding:

- `result.json` — every metric, for comparing runs mechanically.
- `summary.md` — the table a reviewer reads in a pull request.

Runs against the real model are committed here, so that a regression in
structural fidelity or in the judge's scores is visible in review
(specification section 10.4). Runs made with `--fake` are not worth committing:
they measure the runner, not the translation.
