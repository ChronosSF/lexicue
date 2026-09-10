# Subtitle Translator — Phase 1

Phase 1 of the product described in `subtitle-translator-spec.md`: the
translation harness, the subtitle parser and serialiser, the metered price
function, a command-line tool and the evaluation corpus and runner. No AWS, no
API, no web app — those are Phase 2 and later.

The exit criterion for this phase is that a film and a three-episode season
translate from the command line with 100% structural fidelity on both lanes.
That works today against the deterministic fake model; the one remaining step is
running it against the real Claude API with an `ANTHROPIC_API_KEY`, which
nothing in this repository has done.

## Packages

| Package              | What it is                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/subtitles` | Parser and serialiser for SubRip, MicroDVD and SubViewer, encoding detection, format detection and rejections, and the billable character count. Browser-safe.       |
| `packages/pricing`   | The metered price function, the top-up amounts and the free balance. Zero dependencies, browser-safe.                                                                |
| `packages/harness`   | The model client interface, the versioned prompts, the season and file glossary passes, both lanes, validation and retries, reassembly, verification and the report. |
| `packages/cli`       | `pnpm harness translate …`                                                                                                                                           |
| `evals`              | The eval corpus, the hard and advisory metrics, the LLM-judge rubric and the runner.                                                                                 |

## Getting started

```sh
pnpm install
pnpm lint        # ESLint with type-aware rules, then Prettier
pnpm typecheck   # tsc -b across the workspace
pnpm test        # 496 tests
pnpm test:coverage
```

All four are offline and take about ten seconds in total.

## Running the command-line tool

Nothing below needs an API key.

```sh
# One file
pnpm harness translate evals/corpus/comedy/the-lamp-room.srt --to de --fake

# A three-episode season, sharing one glossary, on the economy lane
pnpm harness translate "evals/corpus/season/*.srt" --to de --lane economy --fake

# The eval, over the whole corpus into two languages
pnpm evals run --fake --to de,bg --sample 6
```

Outputs are written next to their inputs as `<name>.<lang>.<ext>`, UTF-8 with a
byte-order mark. `pnpm harness --help` and `pnpm evals run --help` list every
flag.

The fake model wraps English dialogue in guillemets («like this»), leaving every
tag, control code, index and timecode untouched. That is enough to prove every
structural guarantee, and it is worth nothing at all as a translation: for a
target in a non-Latin script the harness correctly reports every cue as
untranslated, because English is not Bulgarian.

## Testing against the real API

Everything is in place; no code needs to change.

1. **Set the key.** `export ANTHROPIC_API_KEY=sk-ant-…`. Without it the tool
   refuses to start and says so; with it, `--fake` is simply left off.
2. **Run the smallest thing first.**

   ```sh
   pnpm harness translate evals/corpus/comedy/the-lamp-room.srt --to de
   ```

   38 cues, about 1,700 characters of dialogue: one glossary call and one batch,
   roughly **two cents** of model spend. It exercises the whole path — the
   cached prefix, structured outputs, validation, the re-parse — for less than
   the price of nothing. Check the printed report for a cache warning: if it
   says the batches read nothing from the prompt cache, the prefix is not
   byte-identical and that is a bug worth stopping for.

3. **Then the season, on both lanes.**

   ```sh
   pnpm harness translate "evals/corpus/season/*.srt" --to de
   pnpm harness translate "evals/corpus/season/*.srt" --to de --lane economy
   ```

   Three episodes, about 15 cents on the fast lane. The economy run submits one
   Message Batch and then polls for up to 23 hours, so start it and leave it.

4. **Then the eval.**

   ```sh
   pnpm evals run --to de,es,fr,pl,bg,el,ja,hi
   ```

   The whole corpus into eight languages, with judging. On the current, reduced
   corpus that is a few dollars; the specification's estimate for the
   full-length corpus is $25 to $35 per run (section 10.4). `--no-judge` removes
   the judging spend.

**What a real run costs at production scale**, from specification section 5.3:
a feature film is about **$0.75** on the fast lane and **$0.58** on the economy
lane; a 45-minute drama episode $0.39 and $0.25; a 22-minute sitcom episode
$0.20 and $0.13. Set a spend limit in the Anthropic Console before the first
run, as section 6.8 says.

## The measurements specification section 5.5 asks for

| What to measure                                        | Where the code records it                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Thinking overhead at `low`, `medium` and `high` effort | `report.usage.outputTokens` per file, printed by the CLI and stored in `result.json`. Sweep with `pnpm harness translate … --effort low\|medium\|high` on the same file and compare. |
| Real expansion factors per target language             | `report.dialogueChars` against `report.usage.outputTokens` for the same file into each target; the eval runner records both for every file and language in one `result.json`.        |
| Characters of dialogue per token per language          | The same two fields; this is what ties the price per 1,000 characters to the cost per token.                                                                                         |
| The economy lane's cache-hit rate                      | `advisory.cacheReadShare` in the eval results, and `usage.cacheReadInputTokens` against `usage.cacheCreationInputTokens` in every file report.                                       |
| The economy lane's turnaround                          | `report.wallTimeMs`, which spans submission to collection on that lane.                                                                                                              |
| Whether Haiku 4.5 is acceptable for the economy lane   | `--model claude-haiku-4-5` on the CLI or the eval runner; the judge's four axes in `result.json` are the comparison.                                                                 |

The cost model itself (`packages/harness/src/cost.ts`) carries the price table
of specification section 5.1 and reproduces the worked breakdown of section 5.4
to the cent, so a measured usage record converts to dollars without a
spreadsheet.

## Handover: what was left out, and what was simplified

Everything here is deliberate. Nothing in this list is a bug.

**Not built, because it is not Phase 1**

- No CDK, API, worker, poller, zip builder, SPA, wallet or Stripe. Those are
  Phases 2 and 3.
- No `packages/shared`. Its contents are the zod schemas of the API contract,
  which has no consumer until Phase 2.
- No GitHub Actions workflows. `pnpm lint`, `pnpm typecheck` and `pnpm test` are
  the whole of continuous integration's Phase 1 surface and run in seconds; the
  `cdk diff` and smoke-test jobs of specification section 9.4 need a stack to
  point at. Conventional commits are used throughout, but release-please is not
  configured.
- The economy lane raises `BatchNeverEndedError` when a Message Batch has not
  ended inside the configured window, which is the signal specification section
  4.5 asks for. Acting on it — re-running those files on the fast lane and
  refunding them — needs the poller and the wallet, so the command-line tool
  simply reports it.
- `client.messages.batches.cancel` is never called. Nothing in Phase 1 cancels
  a batch.

**Choices where the specification left room**

- **The `Cue` model has one field the specification's section 4.3 listing does
  not.** `linePrefixCodes` holds the codes stripped from the start of _each_
  line, with `prefixCodes` still equal to the first entry exactly as specified.
  One cue-level string cannot re-attach the codes in the specification's own
  MicroDVD example, `- Yes.|- {y:i}Never.`, faithfully. `SubtitleDocument` also
  gains `warnings` and an optional `frameRate`.
- **Control codes that are not at the start of a line stay in the text the
  model sees.** They are protected the way inline tags are — by the markup
  multiset check, with a re-wrap that puts a dropped code back and strips an
  invented one — rather than by removal. Cue-leading codes, including every
  `{\an8}` positioning override, are removed entirely as specified.
- **The fallback model for a `refusal` defaults to `claude-opus-5`.** The
  specification says only that the id lives in configuration. This is the rare
  path where cost is immaterial and capability is the point.
- **The one-hour cache write is priced at twice the base input rate** ($4 per
  million tokens on Sonnet 5). The specification's table in section 5.1 gives
  only the five-minute rate.
- **Files in an upload are translated in order, not three at a time.** The
  three-at-once limit of section 3.2 is a per-user product limit enforced at job
  creation, which is Phase 2; here the ordering is load-bearing, because it is
  what lets a character introduced in episode two reach episode three.
- **A `judge` value was added to the harness's `RequestPurpose`.** The eval
  runner scores through the same client interface; the judge's schemas stay in
  the eval package and never enter the product.

**Places where a byte is not preserved**

The fidelity guarantee — cue count, index lines, timing lines, control codes —
holds absolutely, and is verified by re-parsing every output. Three
whitespace-level normalisations exist around it:

- A file that ends with **no newline at all** gets one. `trailingNewline` is the
  boolean the specification's interface defines, and one boolean distinguishes
  two endings, not three. The two common endings — a closing blank line, and a
  single newline — both round-trip byte for byte.
- **Mixed line endings** are normalised to whichever ending the file uses more
  often.
- **SubViewer** cue text is always written back joined with `[br]`, which is
  that format's own line separator. A file that used physical newlines inside a
  cue block comes back using `[br]`.

**Smaller decisions worth knowing**

- `dialogueChars` counts Unicode code points, so an emoji or an astral character
  counts once. HTML entities count as their literal characters (`&amp;` is
  five), because un-escaping them would change what the file contains.
- The encoding detector prefers the code pages specification section 3.1 names,
  then accepts five more that the detector can produce and this project can read
  perfectly well, and falls back to Windows-1252 rather than refusing a file.
- `packages/subtitles` and `packages/pricing` are browser-clean, and an ESLint
  rule fails the build if a Node built-in or a Node global reaches them. The one
  exception is the `@subtitle-translator/subtitles/encoding` entry point, which
  uses `iconv-lite` and `chardet` and needs a `Buffer` polyfill in a browser
  bundle — every bundler supplies one, and the browser preview of Phase 2 is the
  first consumer.
- Coverage thresholds are enforced in CI only on `packages/subtitles` and
  `packages/pricing`, which is where the specification sets a target.

**Not measured, because it needs people or a key**

- Every number in specification sections 5 and 6 is still modelled rather than
  measured. The table above says where each measurement will land.
- The blind pairwise preference test against the cheap tools of section 6.7,
  which decides whether the fast lane keeps its premium, needs native speakers.
- The eval corpus is eleven hand-written files of 23 to 39 cues rather than the
  twenty files of 300 to 2,600 cues section 10.4 asks for. It covers every
  _shape_ — three genres, a hearing-impaired edition, three formats, three
  source languages, a three-episode season — but not a feature film's length.
  `evals/README.md` says so at the top, and writing the full-length fixtures is
  the first thing to do before the eval decides anything about price or effort.

## Test counts and coverage, as measured

496 tests in 20 files, all offline.

| Package              | Statements |   Branches |  Functions |      Lines |
| -------------------- | ---------: | ---------: | ---------: | ---------: |
| `packages/subtitles` |     98.94% |     93.98% |       100% |     99.39% |
| `packages/pricing`   |       100% |       100% |       100% |       100% |
| `packages/harness`   |     96.67% |     87.37% |     97.14% |     97.97% |
| `packages/cli`       |     90.96% |     72.95% |       100% |     92.41% |
| `evals`              |     92.86% |     76.60% |     96.67% |     95.11% |
| **All**              | **96.15%** | **86.00%** | **97.94%** | **97.33%** |

Specification section 10.1 sets a 95% target on `packages/subtitles` and
`packages/pricing`; both are past it and the threshold is enforced by
`pnpm test:coverage`.
