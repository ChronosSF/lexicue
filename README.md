# Lexicue

The product described in `lexicue-spec.md`. Two phases are in this
repository.

**Phase 1** is the engine: the translation harness, the subtitle parser and
serialiser, the metered price function, a command-line tool and the evaluation
corpus and runner. Its exit criterion — a film and a three-episode season
translating with 100% structural fidelity on both lanes — is met against the
deterministic fake model, and the fast lane has now been run against the real
Claude API: see "as measured on 11 September 2026" below, and the three cache
bugs those runs found. The economy lane has now been run too, on 12 September
2026, which found a fourth bug before it ran at all.

**Phase 2, in progress** is the web app in `apps/web`. It runs two ways: against
a local development API that translates with Claude for real, or against a mock
backend that runs the whole product in the browser with a fake model. Nothing on
AWS exists yet.

```sh
pnpm install
cp .env.example .env   # and paste the key after the equals sign

pnpm dev        # the app at http://localhost:5173 and the local API on 5174
pnpm dev:mock   # the app alone, in the browser, with no key and no network
```

`pnpm dev` starts both processes and stops both on Ctrl+C. Without a key it
stops and says so, naming `.env.example`, rather than quietly falling back to
the mock. Drop a subtitle file, pick a language, and a real translation comes
back downloadable with its report; **the money is simulated and the app says
so**, but the model spend is real. Read `apps/web/README.md` for what is real
and what is not, for the reason the local API is its own process, and for every
place the specification was ambiguous or wrong.

## Packages

| Package              | What it is                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/subtitles` | Parser and serialiser for SubRip, MicroDVD and SubViewer, encoding detection, format detection and rejections, and the billable character count. Browser-safe.       |
| `packages/pricing`   | The metered price function, the top-up amounts and the free balance. Zero dependencies, browser-safe.                                                                |
| `packages/harness`   | The model client interface, the versioned prompts, the season and file glossary passes, both lanes, validation and retries, reassembly, verification and the report. |
| `packages/shared`    | The zod schemas of the API contract in specification section 7.3, shared by the app now and the Lambda handlers later.                                               |
| `apps/web`           | The React SPA: the three states of section 2, with a mock backend that implements section 7.3 in the browser.                                                        |
| `packages/cli`       | `pnpm harness translate …`                                                                                                                                           |
| `packages/dev-api`   | The contract of section 7.3 on plain `node:http`, running the harness in-process, so `pnpm dev` can translate for real. Development only; nothing deployed runs it.  |
| `evals`              | The eval corpus, the hard and advisory metrics, the LLM-judge rubric and the runner.                                                                                 |

## Getting started

```sh
pnpm install
pnpm dev         # the web app and the local API; needs a key in .env
pnpm dev:mock    # the web app alone, in mock mode; needs nothing
pnpm dev:api     # just the local API, on port 5174
pnpm lint        # ESLint with type-aware rules, then Prettier
pnpm typecheck   # tsc -b across the workspace, then the app
pnpm test        # 624 tests, in two Vitest projects: the packages and the app
pnpm test:coverage
pnpm --filter web build
```

Everything except `pnpm dev` is offline and takes under a minute in total. The
tests never touch the network or the key: the local API is driven over real HTTP
against the deterministic fake model client.

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

Steps 1 to 3 have now been run on both lanes, and a fourth file added for step
3½; what they measured, and the four fixes they forced, are in the sections
after this one. Step 4 has never been run.

1. **Set the key.** Copy `.env.example` to `.env` at the repository root and
   paste the key after the equals sign. The file is git-ignored, and only the
   command-line tool and the eval runner read it; nothing deployed does, since
   specification section 9.8 keeps secrets in Secrets Manager. A value in
   `.env` wins over one exported in the shell, so this checkout always uses
   its own key, and the tool says so on stderr whenever it overrides one.
   Exporting `ANTHROPIC_API_KEY` still works when there is no file. Without a
   key the tool refuses to start and says so; with one, `--fake` is simply
   left off.
2. **Run the smallest thing first.**

   ```sh
   pnpm harness translate evals/corpus/comedy/the-lamp-room.srt --to de
   ```

   38 cues, 1,062 characters of dialogue: one glossary call and one batch,
   **three cents** of model spend as measured. It exercises the whole path — the
   cached prefix, structured outputs, validation, the re-parse — for less than
   the price of nothing.

   A file this small is one batch, so it reads nothing from the prompt cache and
   is right not to: the batch that runs first is the one that writes the entry,
   and the glossary pass cannot warm it (see the measurements below). The
   warning to stop for is the one that fires when a file has several batches and
   _none_ of them read, which means the prefix bytes moved between requests.

3. **Then the season, on both lanes.**

   ```sh
   pnpm harness translate "evals/corpus/season/*.srt" --to de
   pnpm harness translate "evals/corpus/season/*.srt" --to de --lane economy
   ```

   Three episodes, 9 cents of model spend on the fast lane as measured, and
   under 3 cents on the economy lane. The economy run submits one Message Batch
   and then polls for up to 23 hours, so start it and leave it; the one that has
   been run came back in eight minutes.

4. **Then the eval.**

   ```sh
   pnpm evals run --to de,es,fr,pl,bg,el,ja,hi
   ```

   The whole corpus into eight languages, with judging. **Projected at $13 to
   $18 on the present corpus**, from the measured per-file costs below;
   `--no-judge` takes it to $10 to $12. **This needs the founder's approval and
   has never been run.** Specification section 10.4 budgets $25 to $35, which
   does not reconcile with its own corpus and targets; `apps/web/README.md` says
   why.

**What a real run costs at production scale**, from specification section 5.3:
a feature film is about **$0.75** on the fast lane and **$0.58** on the economy
lane; a 45-minute drama episode $0.39 and $0.25; a 22-minute sitcom episode
$0.20 and $0.13. Set a spend limit in the Anthropic Console before the first
run, as section 6.8 says.

## The measurements specification section 5.5 asks for

| What to measure                                        | Where the code records it                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thinking overhead at `low`, `medium` and `high` effort | `report.usage.outputTokens` per file, printed by the CLI and stored in `result.json`. Sweep with `pnpm harness translate … --effort low\|medium\|high` on the same file and compare.              |
| Real expansion factors per target language             | `report.dialogueChars` against `report.usage.outputTokens` for the same file into each target; the eval runner records both for every file and language in one `result.json`.                     |
| Characters of dialogue per token per language          | The same two fields; this is what ties the price per 1,000 characters to the cost per token.                                                                                                      |
| The economy lane's cache-hit rate                      | `advisory.cacheReadShare` in the eval results, and `usage.cacheReadInputTokens` against `usage.cacheCreationInputTokens` in every file report.                                                    |
| The economy lane's turnaround                          | `report.wallTimeMs`, which spans submission to collection on that lane.                                                                                                                           |
| Whether Haiku 4.5 is acceptable for the economy lane   | **Measured, and the answer is no** — the dated comparison below. Sonnet 5 translates on both lanes, and the economy lane's discount comes from the Message Batches API, not from a cheaper model. |

The cost model itself (`packages/harness/src/cost.ts`) carries the price table
of specification section 5.1 and reproduces the worked breakdown of section 5.4
to the cent, so a measured usage record converts to dollars without a
spreadsheet.

### As measured on 11 September 2026

The first real runs this repository has made, on `claude-sonnet-5` at effort
`medium`, fast lane, into German. Both files came back with every index, timing
line, control code and inline tag identical to the source, re-parsed and
compared cue by cue, and every cue translated.

| Run                        | Cues | Dialogue chars | Tokens in | Tokens out | Cache reads | Cache writes | Model cost | Wall time | Price charged |
| -------------------------- | ---: | -------------: | --------: | ---------: | ----------: | -----------: | ---------: | --------: | ------------: |
| `comedy/the-lamp-room.srt` |   38 |          1,062 |     2,126 |      1,878 |           0 |        3,620 |    $0.0321 |    18.7 s |         $0.10 |
| `season/*.srt`, 3 episodes |   81 |          2,096 |    12,493 |      5,660 |       9,075 |        1,148 |    $0.0863 |    49.4 s |         $0.30 |

**These numbers do not scale to the specification's estimates, and they are not
meant to.** Section 5.3 models a 350-cue sitcom episode at $0.20 and a
1,400-cue film at $0.75, which is $0.0125 of model cost per 1,000 characters of
dialogue. The corpus files are 23 to 39 cues, twenty to forty times shorter, so
the fixed cost of a file — the 1,500-token system prompt, the glossary pass and
its thousand output tokens, one cache write — is never amortised and the same
arithmetic gives $0.030 and $0.041 per 1,000 characters. The 10-cent minimum
price covers it, exactly as section 6.4 intends, and both runs were profitable.
What section 5.3 predicts cannot be confirmed or refuted until the full-length
fixtures of section 10.4 exist; writing them remains the first thing to do.

Two things here _are_ measured rather than modelled, and both changed the code:

- **A file's glossary pass cannot warm the prefix its batches read.** A
  request's structured-output schema renders ahead of the system prompt, the way
  a tool list does, and is part of the cache key. Three requests over one
  document proved it: the glossary pass wrote the prefix, a batch with
  byte-identical prefix bytes wrote it again instead of reading, and only a
  second batch read. Specification section 4.4 assumes otherwise.
- **A cold fan-out is a race nobody wins.** Twelve concurrent batch requests
  over a prefix nothing had warmed each wrote their own copy and none read; the
  same twelve run afterwards all read and wrote nothing. On the film of section
  5.4 that is about $0.74 of cache writes against the $0.12 the section budgets.
  The fast lane now lets the first batch land before the rest fan out, which
  costs roughly one batch of latency and restores the section's arithmetic.

The season run shows the cache working: 9,075 read tokens against 1,148 written,
because the three files share the system-prompt entry, and the season glossary
carried across episodes — "The Light has opinions" is `Das Licht hat Meinungen`
in all three, and Marta, Petar and Skerry Point are spelled identically
throughout.

### Why Haiku 4.5 is not an option, as measured on 11 September 2026

**Claude Sonnet 5 is the translation model on both lanes. Haiku 4.5 is not a
fallback, a candidate or an open question; it was measured against Sonnet 5 on
11 September 2026 and it is not good enough for what this product sells.** The
economy lane is Sonnet 5 through the Message Batches API, so its discount comes
from the API's half price rather than from a weaker model. The comparison below
is the dated record of why, and the capability table in
`packages/harness/src/model-capabilities.ts` keeps Haiku's request surface as
data so a future measurement of any model costs nothing to set up.

This decision settles what the specification left open in section 5.1 ("held in
reserve"), section 6.9 (the "prepared fallback" at 1 cent per 1,000 characters)
and section 12.1 item 7. The specification is not wrong about any of it — it
asked for the measurement before deciding, the measurement was made, and this is
the answer.

The same four files — `comedy/the-lamp-room.srt` and the three-episode season,
119 cues, 3,158 characters of dialogue — into German and Bulgarian, fast lane.
Sonnet 5 at effort `medium`; Haiku 4.5 with no effort parameter and no thinking,
which is the only cheap configuration it has. Every one of the sixteen outputs
re-parsed with every index line, timing line and inline tag identical to its
source, every cue translated, no repairs, and no fallback to Opus 5 on any file.

| Arm                  | Model cost | Per 1,000 chars | Tokens in | Tokens out | Cache reads | Wall time |
| -------------------- | ---------: | --------------: | --------: | ---------: | ----------: | --------: |
| German, Sonnet 5     |    $0.1184 |         $0.0375 |    14,619 |      7,538 |       9,075 |    68.0 s |
| German, Haiku 4.5    |    $0.0487 |         $0.0154 |    21,623 |      5,410 |           0 |   134.6 s |
| Bulgarian, Sonnet 5  |    $0.1256 |         $0.0398 |    16,199 |      7,950 |       9,075 |    87.2 s |
| Bulgarian, Haiku 4.5 |    $0.0416 |         $0.0132 |    18,593 |      4,593 |           0 |   107.0 s |

Haiku costs **37% of Sonnet** across both languages and takes **about twice as
long** in wall time. It reads nothing from the prompt cache at this file length
and is right not to: its minimum cacheable prefix is 4,096 tokens and the
largest request here was 3,419, so no entry is ever created. At feature length
the prefix clears that bar and the cost gap would widen. That is the whole case
for it, and it is a cost case.

Cheaper is not the same as good enough, and the season is where it shows:

- **Haiku renders the season's own location three ways in three episodes.**
  `Skerry Point` is `СКЕРИСТИ ПУНКТ` in episode one, `СКЕЪРИС ПОИНТ` in episode
  two and left as `SKERRY POINT` in Latin script in episode three. Sonnet writes
  `СКЕРИ ПОЙНТ` in all three. Character names hold on both models.
- **Haiku leaves screen text untranslated in German.** All six episode title and
  end cards — `SKERRY POINT - EPISODE ONE`, `END OF EPISODE ONE` — come back in
  English; Sonnet translates them (`FOLGE EINS`). The cues are structurally
  valid, so no hard metric catches it.
- **The running joke drifts.** `The Light has opinions` is `hat Meinungen` in
  all of Sonnet's episodes; Haiku moves to the singular `hat eine Meinung`
  through episode two and back again in episode three. Haiku's Bulgarian keeps
  the joke consistent.

Haiku also flags worse on the advisory yardsticks in German: 21 reading-speed
and 17 line-length findings against Sonnet's 15 and 12 over the same 119 cues.

All three failures are the thing this product sells. A name that changes
spelling between episodes, screen text left in English and a running joke that
drifts are exactly what whole-season context is for, and they are what the
market argument in specification section 6.7 rests on. A model that loses them
is not a cheaper version of the product; it is one of the cheap tools the
premium is meant to be earned against. That is why the decision is closed rather
than deferred to a judged run, and why nothing about Haiku 4.5 is left to
measure — a thinking budget might narrow the quality gap, but a Haiku that
thinks is no longer the cheap arm of the comparison.

The outputs are under `.local/runs/2026-09-11-2200-*`, one directory per arm,
each with its `report.json`. No judge was run: these are structural, cost and
consistency measurements plus a reading of the files.

Still unmeasured: every effort level other than `medium`, and every language
other than German and Bulgarian. No LLM judge has scored a run on the rubric.
The economy lane has since been run; the next section is what it measured.

### The economy lane, as measured on 12 September 2026

The first Message Batch this repository has ever submitted. The same three
Skerry Point episodes as the fast-lane row above, into German, on
`claude-sonnet-5` at effort `medium`. Outputs and report under
`.local/runs/2026-09-12-1650-season-de-economy/`.

| Lane, same three files | Cues | Dialogue chars | Tokens in | Tokens out | Cache reads | Cache writes | Model cost | Per 1,000 chars |  Turnaround |
| ---------------------- | ---: | -------------: | --------: | ---------: | ----------: | -----------: | ---------: | --------------: | ----------: |
| Fast, 11 September     |   81 |          2,096 |    12,493 |      5,660 |       9,075 |        1,148 |    $0.0863 |         $0.0412 |      49.4 s |
| Economy, 12 September  |   81 |          2,096 |     9,564 |      2,331 |       2,568 |        2,432 |    $0.0263 |         $0.0126 | 8 min 4 sec |

**It did not run the first time, and the refusal cost money.** Specification
section 4.5 gives every batch request a `custom_id` of `{jobId}:{batchIndex}`;
the Message Batches API requires `^[a-zA-Z0-9_-]{1,64}$` and answers the whole
submission with one 400. By then the season glossary pass and all three file
glossary passes had run and been paid for — roughly 5 cents — for nothing. The
separator is now an underscore and every id is checked before the request
leaves; `apps/web/README.md` records it under "where the specification is
wrong".

**Turnaround, 8 minutes 4 seconds**, from the command starting to the report
being written, which includes the four glossary passes as well as the batch.
The poller asks once a minute, so the batch itself ended somewhere inside the
last of those minutes. Section 4.5 promises "usually within the hour" and
section 3.2 a 24-hour ceiling; a three-request batch was well inside both.

**Cache, 2,568 read tokens against 2,432 written: a 51% read share.** Section
4.5 models this lane at 50% "until measured", and 51% is what came back — but
the agreement is a coincidence, and the number does not answer the question the
section is uncertain about. These three files are one batch each, so nothing
here tests whether a dozen requests _inside one Message Batch_ share a prefix.
The 51% is the system prompt being written by the first file and read by the
other two, which is exactly what the fast lane does. Measuring the real
question needs a multi-batch file on this lane: `drama/the-signal-box.srt` now
exists for it, and one run of it would cost about 9 cents. **Nobody has run
that yet**, and until somebody does, section 5.3's economy column rests on an
assumption.

**Cost, $0.0263 against the fast lane's $0.0863 on the same files — 30%.** Half
of that saving is certain: the Message Batches API halves every token price and
`packages/harness/src/cost.ts` applies it. The other half is that this run
emitted 2,331 output tokens where the fast-lane run emitted 5,660 over the same
81 cues, with an identical request on both lanes — the harness builds one
request object and hands it to `messages.parse` or `messages.batches.create`.
One run cannot say whether Sonnet 5 thinks less inside a batch or whether this
is ordinary variance in adaptive thinking. Priced at the fast lane's own output
volume the economy run would have cost about $0.043, which is the 50% the
Batches API guarantees. **Plan on 50%, not 30%**, until a second run says
otherwise.

**Structural fidelity, and the text.** All three files re-parsed with every
index line, timing line and inline tag identical to the source, every cue
translated, no repairs, no fallback. Against the fast lane's German of the same
files, 53 of the 81 cues are word-for-word identical and the rest are ordinary
paraphrase. The three things Haiku 4.5 lost are all held: `Das Licht hat
Meinungen` is plural in all three episodes, Marta, Ivo and Petar are spelled
identically throughout, and the episode cards are translated (`FOLGE EINS`)
rather than left in English. Two differences are differences rather than
faults — the economy run renders "the tender" as `Versorger` where the fast run
used `Tender`, and "paraffin" as `Petroleum` rather than `Paraffin`, which for
a lighthouse lamp is the better of the two readings.

One reporting gap this run exposed: the upload total counts the three file
reports and not the season glossary pass, so the $0.0263 above is the sum of
the files and the true spend is a little higher. The same is true of the
fast-lane figure, so the comparison holds.

### A multi-batch file, as measured on 12 September 2026

`drama/the-signal-box.srt` — 400 cues, 13,339 characters, four batches at the
default batch size of 120 — into German on the fast lane, `claude-sonnet-5` at
effort `medium`. The first file this repository has translated that is more than
one batch. Outputs under `.local/runs/2026-09-12-1710-signal-box-de/`.

| What              | Measured                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| Wall time         | 100.6 s for 400 cues, four batches, first batch alone then three at once |
| Tokens            | 24,675 in, 16,705 out                                                    |
| Cache             | 8,766 written **once**, 28,039 read                                      |
| Model cost        | $0.2439, against $0.41 charged                                           |
| Per 1,000 chars   | $0.0183                                                                  |
| Per cue           | $0.00061                                                                 |
| Repairs, untrans. | none, none                                                               |
| Advisory          | 102 cues over 20 characters per second, 66 lines over 42 characters      |

**Every batch after the first read the cached prefix.** The proof is in the
write column: 8,766 cache-creation tokens is exactly one prefix, so only the
first batch wrote one, and the 28,039 read tokens are the other three batches
plus the glossary pass reading it back. This is the path specification section
4.4 describes and section 5.4 prices, and it had never run before: every other
fixture is a single batch, which writes the entry and reads nothing.

**Consistency held across all four batches.** The running line "The line
doesn't care." comes back as `Der Strecke ist das egal.` in all nine places it
appears, in every one of the four batches, with no variation at all. Agnes,
Dessie, Rosaleen, Mr. Bracewell, Fintan, Ballyfin Halt and Kilcarn Junction are
spelled identically throughout. The lever joke survives as a number: the count
is `Einunddreißig.` in batches 0, 1 and 2, and `Zweiunddreißig.` at the payoff
in batch 3. Every index line, timing line and inline tag came back identical to
the source, re-parsed and compared cue by cue.

**Against section 5.3's cost model.** The section prices a 1,400-cue,
60,000-character film at $0.75, which is $0.0125 per 1,000 characters and
$0.000536 per cue. This file came in at **$0.0183 per 1,000 characters, 46%
above the model — but $0.00061 per cue, only 14% above it.** Put the three
measured fast-lane runs in one column and the pattern is hard to miss:

| File                     | Cues | Chars/cue | Per 1,000 chars |   Per cue |
| ------------------------ | ---: | --------: | --------------: | --------: |
| `season/*.srt` (3 files) |   81 |      25.9 |         $0.0412 | $0.001065 |
| `comedy/the-lamp-room`   |   38 |      27.9 |         $0.0302 | $0.000845 |
| `drama/the-signal-box`   |  400 |      33.3 |         $0.0183 | $0.000610 |
| Section 5.3's film       | 1400 |      42.9 |         $0.0125 | $0.000536 |

Cost per cue moves by a factor of two across that range; cost per 1,000
characters moves by a factor of three. **A real part of the cost is per cue and
not per character** — the id and the `{"i":…,"t":"…"}` wrapper are the same
size whether a cue holds four words or fourteen — and the price is metered per
character. A file of short, dense exchanges therefore costs more to produce per
character than section 5.3's arithmetic says, and earns less per cue. It is not
a problem at these margins, and the 10-cent minimum covers the small end, but
it is the reason a hearing-impaired edition or a rapid-dialogue comedy is the
worst case rather than a long film. **Nobody should conclude from three files
that the model needs changing**; the point is that the next measurement worth
making is a file with the section's own 43 characters per cue.

The advisory count is a property of the fixture, not of the translation: its
timings were laid out at 13 to 19 characters per second in English, and German
expands, so a quarter of the cues land over the 20-per-second threshold. A
professionally timed source would leave more room.

### What a full real eval would cost, for the founder to approve

**Not run.** Projected from the measurements above, for the enlarged corpus of
13 files, 1,740 cues and 54,217 characters into the eight targets of section
10.4, with the Opus 5 judge:

| Part                                            |      Cost |
| ----------------------------------------------- | --------: |
| Translation, German pass (measured where known) |     $1.17 |
| Translation, all eight targets                  |    $10.25 |
| Judging, Opus 5, 20 cues per file               |     $4.00 |
| Cross-episode consistency judging               |     $0.26 |
| **Total**                                       | **$14.5** |

Call it **$13 to $18**, and $10 to $12 with `--no-judge`. What is measured in
that: the signal box at $0.2439, the season at $0.0863, the lamp room at
$0.0321, and Bulgarian costing 1.06 times German over the same four files. What
is modelled: the 1,000-cue file by interpolation, the seven short files at the
lamp room's cost, and Greek, Japanese and Hindi at 1.17 to 1.28 times German on
section 5.2's expansion factors, which are themselves estimates. The judge
figure assumes it reads every file whole, which `renderJudgeRequest` does.

**`pnpm evals run` without `--fake` costs this much and needs the founder's
approval.** Nobody has run it.

## Handover: what was left out, and what was simplified

Everything here is deliberate. Nothing in this list is a bug.

**Not built, because it is not Phase 1**

This list was written when Phase 1 was all there was. Two of its entries have
since been overtaken by Phase 2, and say so.

- No CDK, no deployed API, worker or poller, and no Stripe. Those are Phases 2
  and 3. A zip builder, a wallet and the SPA now exist, in `packages/dev-api`
  and `apps/web`, as a local development stand-in rather than the deployed
  thing.
- `packages/shared` now exists: the zod schemas of the API contract, plus the
  wallet arithmetic and the same-language refusal that every implementation of
  the contract has to agree on.
- One GitHub Actions workflow, `.github/workflows/ci.yml`, described under
  "Continuous integration" below. `deploy.yml`, `evals.yml` and `rollback.yml`
  from specification section 9.1 do not exist, because all three need an AWS
  account. Conventional commits are used throughout, but release-please is not
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
  exception is the `@lexicue/subtitles/encoding` entry point, which
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
- The eval corpus is thirteen hand-written files, 1,740 cues and 54,217
  characters, against the twenty files of 300 to 2,600 cues section 10.4 asks
  for. Eleven of them are 23 to 39 cues and cover every _shape_ — three genres,
  a hearing-impaired edition, three formats, three source languages, a
  three-episode season. The two full-length ones, `drama/the-signal-box.srt` at
  400 cues and `comedy/the-inventory.srt` at 1,000, cover the length: four and
  nine batches, priced by the metered rate rather than the 10-cent floor, and
  written so a recurring line falls in every batch. What is still short is
  breadth, and a file at the 2,600-cue end. `evals/README.md` has the detail.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to
`main`. It is one job on `ubuntu-latest`: check out, install pnpm, install
Node.js 24, `pnpm install --frozen-lockfile`, then the same four commands
"Getting started" lists above — `pnpm lint`, `pnpm typecheck`,
`pnpm test:coverage`, `pnpm --filter web build` — in that order. Keeping the
workflow a thin wrapper over the package scripts is what makes a red run
reproducible locally in one command.

Three details are deliberate:

- **The pnpm version comes from `package.json`.** `pnpm/action-setup` is given
  no `version` input, so it reads the `packageManager` field and CI installs the
  same pnpm a developer does. `cache: true` caches the pnpm store, keyed on
  `pnpm-lock.yaml`.
- **`--frozen-lockfile`** makes a lockfile that no longer matches
  `package.json` a failure rather than a quietly different dependency tree.
- **A concurrency group cancels superseded runs**, so pushing twice to a branch
  leaves one running job and one answer instead of two.

The coverage thresholds of specification section 10.1 are enforced by
`pnpm test:coverage` itself, in `vitest.config.ts`, so they fail the same way in
CI and on a laptop.

**What of specification section 9.4 is not here yet**, and what each part needs:

| 9.4 step                    | Status                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install, lint, types, tests | Done.                                                                                                                                                                               |
| Build the SPA               | Done.                                                                                                                                                                               |
| `cdk synth`                 | No `infra/` app exists to synthesise.                                                                                                                                               |
| `cdk diff` against staging  | Needs a deployed stack and a read-only OIDC role in an AWS account. There is no account.                                                                                            |
| Dependency audit            | `pnpm audit --audit-level high` passes on this commit but is not a workflow step: nobody has decided yet whether a newly published advisory should block an unrelated pull request. |
| Secret scanning             | GitHub's own secret scanning and push protection are repository settings rather than workflow steps, and the founder has to turn them on.                                           |

The founder pushes, so this workflow has never run on GitHub. What has been
done is to validate it as YAML against the SchemaStore GitHub workflow schema,
check `actions/checkout@v7`, `actions/setup-node@v7` and `pnpm/action-setup@v6`
against the current major version of each, and run every one of its steps
locally on this commit.

## Test counts and coverage, as measured

618 tests in 34 files, all offline: nothing in the suite touches the network or
the key, and the local development API is driven over real HTTP against the
deterministic fake model client.

| Package              | Statements |   Branches |  Functions |      Lines |
| -------------------- | ---------: | ---------: | ---------: | ---------: |
| `packages/subtitles` |     98.33% |     92.55% |       100% |     99.51% |
| `packages/pricing`   |       100% |       100% |       100% |       100% |
| `packages/harness`   |     96.99% |     87.55% |     97.84% |     98.35% |
| `packages/shared`    |     99.12% |     83.87% |       100% |       100% |
| `packages/cli`       |     91.62% |     74.24% |       100% |     92.86% |
| `packages/dev-api`   |     79.93% |     70.85% |     87.58% |     82.11% |
| `evals`              |     92.86% |     76.60% |     96.67% |     95.11% |
| **All**              | **92.56%** | **82.81%** | **95.37%** | **94.06%** |

`packages/dev-api` is the lowest, and deliberately so: the parts of it that are
not covered are the executable entry points (`bin.ts`, `dev.ts`), which start
processes, and the error paths that only a real model outage reaches.

Specification section 10.1 sets a 95% target on `packages/subtitles` and
`packages/pricing`; both are past it and the threshold is enforced by
`pnpm test:coverage`.
