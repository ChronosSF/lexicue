# Subtitle Translator

Phase 1 of the subtitle translation product described in `subtitle-translator-spec.md`:
the translation harness, the subtitle parser and serialiser, the metered price function,
a command-line tool and the evaluation corpus and runner. No AWS, no API, no web app yet.

## Packages

| Package              | What it is                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `packages/subtitles` | Parser, serialiser, format and encoding detection, billable character count                |
| `packages/pricing`   | The metered price function and top-up amounts                                              |
| `packages/harness`   | Model client interface, prompts, glossary passes, batch orchestration, validation, reports |
| `packages/cli`       | `pnpm harness translate ...`                                                               |
| `evals`              | Eval corpus, metrics, LLM-judge rubric and runner                                          |

## Getting started

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

More detail, including how to run the command-line tool and what an operator must do to
test against the real Claude API, is added as the packages land.
