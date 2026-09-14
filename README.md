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

**Phase 2, in progress** is the web app in `apps/web`, the authoritative logic
behind it in `packages/core`, and the CDK app in `infra`. The app runs two ways:
against a local development API that translates with Claude for real, or against
a mock backend that runs the whole product in the browser with a fake model.
**Nothing on AWS exists.** There is no account, so the six stacks of
specification section 7.2 are synthesised and asserted rather than deployed;
`infra/README.md` lists what is built, what is stubbed, and what the founder has
to do first.

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
| `packages/core`      | The authoritative logic behind that contract, with no storage and no transport in it: parse and price, charge and refund, the state machine, retention.              |
| `apps/web`           | The React SPA: the three states of section 2, with a mock backend that implements section 7.3 in the browser.                                                        |
| `packages/cli`       | `pnpm harness translate …`                                                                                                                                           |
| `packages/dev-api`   | An HTTP adapter over `packages/core` on plain `node:http`, with a disk store, so `pnpm dev` can translate for real. Development only; nothing deployed runs it.      |
| `evals`              | The eval corpus, the hard and advisory metrics, the LLM-judge rubric and the runner.                                                                                 |
| `infra`              | The CDK app: the six stacks of specification section 7.2 and the Lambda handlers, synthesised and asserted, never deployed.                                          |

## Where the authority lives

`packages/core` holds everything that decides something: what a file is, what
it costs, whether the balance covers it, what state an upload is in, when files
are deleted. It has no storage and no transport in it. Two interfaces are all it
asks of the world, and both are shaped like the AWS call a Phase 2 adapter will
make:

| The core asks for      | Locally               | In Phase 2                                            |
| ---------------------- | --------------------- | ----------------------------------------------------- |
| `MetadataStore.load`   | one JSON file read    | one DynamoDB `Query` on `USER#{sub}` (spec 7.4)       |
| `MetadataStore.commit` | one JSON file write   | one `TransactWriteItems`, with the charge's condition |
| `FileStore`            | files under `.local/` | `PutObject` / `GetObject` / `DeleteObject` (7.2)      |
| `DownloadSigner`       | an HMAC'd local link  | a presigned S3 GET valid 15 minutes                   |

`packages/dev-api` is an adapter over it: read a request, check the development
token, call the core, write JSON. `packages/core/src/core.test.ts` drives the
whole product — grant, upload, charge, translate, refund, retention, account
deletion — against nothing but the in-memory stores, which is the same thing a
Lambda handler will do with two different objects in the constructor.

The one thing deliberately left in `@lexicue/shared` rather than moved into the
core is the wallet arithmetic, because the browser's mock backend has to agree
with it exactly and cannot import a package that reads files. The core owns the
orchestration around it: which rows change, in what order, under what condition.

## Getting started

```sh
pnpm install
pnpm dev         # the web app and the local API; needs a key in .env
pnpm dev:mock    # the web app alone, in mock mode; needs nothing
pnpm dev:api     # just the local API, on port 5174
pnpm lint        # ESLint with type-aware rules, then Prettier
pnpm typecheck   # tsc -b across the workspace, then the app
pnpm test        # 750 tests, in two Vitest projects: the packages and the app
pnpm test:coverage
pnpm --filter web build
pnpm e2e         # 9 Playwright tests through the app in a real browser
```

Everything except `pnpm dev` is offline and takes under a minute in total. The
tests never touch the network or the key: the local API is driven over real HTTP
against the deterministic fake model client. `pnpm e2e` needs a browser the
first time, which is the one download in the list:

```sh
pnpm --filter web exec playwright install chromium
```

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

Steps 1 to 3 have now been run on both lanes, and two more files added for step
3½ — `drama/the-signal-box.srt` for the multi-batch path and
`documentary/the-long-meadow.srt` for the density the price is modelled on.
What they measured, and the four fixes they forced, are in the sections after
this one. Step 4 has never been run.

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

| What to measure                                        | Where the code records it                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thinking overhead at `low`, `medium` and `high` effort | **Measured on 14 September 2026** — the effort sweep below. `low` holds every judge axis inside noise and saves 3.9%, not the 15% sections 5.5 and 6.9 assume; `high` costs 117% more for nothing. Re-measure with `pnpm evals run --effort <level>`. |
| Real expansion factors per target language             | `report.dialogueChars` against `report.usage.outputTokens` for the same file into each target; the eval runner records both for every file and language in one `result.json`.                                                                         |
| Characters of dialogue per token per language          | The same two fields; this is what ties the price per 1,000 characters to the cost per token.                                                                                                                                                          |
| The economy lane's cache-hit rate                      | `advisory.cacheReadShare` in the eval results, and `usage.cacheReadInputTokens` against `usage.cacheCreationInputTokens` in every file report.                                                                                                        |
| The economy lane's turnaround                          | `report.wallTimeMs`, which spans submission to collection on that lane.                                                                                                                                                                               |
| Whether Haiku 4.5 is acceptable for the economy lane   | **Measured, and the answer is no** — the dated comparison below. Sonnet 5 translates on both lanes, and the economy lane's discount comes from the Message Batches API, not from a cheaper model.                                                     |

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

Still unmeasured at the time of that comparison: every effort level other than
`medium`, and every language other than German and Bulgarian. No LLM judge had
scored a run on the rubric. All three have since been done — the economy lane in
the next section, the judge in "The prompt that did not land", and `low` and
`high` in "The effort sweep" below. Every language other than German and
Bulgarian is still unmeasured.

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
| Model cost        | $0.2439, against the $0.41 charged on the day; $0.46 at today's rates    |
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

### The prompt that did not land, as measured on 14 September 2026

Three judged runs of the whole thirteen-file corpus into German, Sonnet 5 at
effort `medium`, fast lane, Opus 5 judging a deterministic 20-cue stratified
sample per file against `lexicue/judge@v1`. `lexicue/system@v3` is the baseline;
`@v4` and `@v5` were written to answer the faults the baseline's judge notes
recorded, and **neither landed**. The prompt is back at `@v3`.

| Measure, corpus-wide               |        v3 |                     v4 |                    v5 |
| ---------------------------------- | --------: | ---------------------: | --------------------: |
| Prompt length (characters)         |     2,842 |           5,131 (+81%) |          4,029 (+42%) |
| Hard metrics (13 files)            |      pass |                   pass |                  pass |
| Accuracy                           |    4.9008 |    4.8962 (**−0.005**) |   4.8615 (**−0.039**) |
| Naturalness                        |    4.8008 |        4.8192 (+0.018) |   4.7962 (**−0.005**) |
| Register                           |    4.9654 |        4.9692 (+0.004) |   4.9538 (**−0.012**) |
| Name consistency                   |    4.9700 |        4.9731 (+0.003) |       4.9846 (+0.015) |
| Reading-speed flags per 1,000 cues |    212.07 |         201.72 (−4.9%) |       187.36 (−11.7%) |
| Long-line flags per 1,000 cues     |    121.27 |        109.19 (−10.0%) |        117.24 (−3.3%) |
| Output tokens                      |    72,926 |        90,667 (+24.3%) |        79,558 (+9.1%) |
| Model cost per cue                 | $0.000610 | $0.000722 (**+18.4%**) | $0.000665 (**+8.9%**) |
| Cache-read share                   |    0.8697 |                 0.8783 |                0.8751 |
| Repeated lines drifting, of 18     |         — |                  **0** |                 **0** |
| Season findings (real ones)        |         2 |                      3 |                     1 |

**The one finding worth keeping.** The two runs are not two failures, they are
one result. v4 held quality about level and cost 18.4% more per cue; v5 cut the
prompt back, the thinking fell from +24.3% to +9.1% of output tokens, and three
of the four judge axes fell with it while the cost was still 8.9% over a 5%
ceiling. **At effort `medium` these rules improve the translation only in
proportion to the thinking they buy, and that thinking is what breaks the
ceiling.** `der-leuchtturm.srt` is the control: German into German, a near-copy
the judge scores 5.00 on every axis, and its output tokens doubled under v4
without a word of its translation changing. The next attempt should move one
rule at a time. Treating effort as the variable rather than holding it at
`medium` was the other half of that suggestion, and it has now been done: the
effort sweep below holds the prompt at `@v3` and moves the effort instead, and
it finds the same shape from the other side — at `high`, 163% more output tokens
buy no judge axis worth having.

**What did work, and needs no model.** In both runs every one of the 18
verbatim-repeated lines in the corpus came back with exactly one rendering: the
400-cue file's nine occurrences of "The line doesn't care." all
"Die Strecke kümmert das nicht.", the 1,000-cue file's fifteen "Count it twice,
say it once." all "Zweimal zählen, einmal sagen.". That is the deterministic
half — the harness finds the repeats from the source and the glossary fixes one
rendering — and it is attributable to the mechanism rather than to any sentence
of the prompt. The detection and the advisory that measures it are kept
(`packages/harness/src/repeats.ts`); the prompt text and the schema fields that
fed the model are reverted. **v3's prompt plus the deterministic fixed
renderings and nothing else is the configuration worth measuring next, and it is
the one configuration none of these three runs covered.** About $2.40.

**The judge is most of the cost, and the projection below is low.** Measured
here: judging one target costs $1.33 to $1.41, not the $4.00 the next section
budgets for all eight. Translation into German cost $1.06 at v3. A judged German
run is $2.39 all in.

| Run                | Translation | Judge (Opus 5) |   Total |
| ------------------ | ----------: | -------------: | ------: |
| v3 baseline, 07:36 |     $1.0615 |        $1.3328 | $2.3943 |
| v4, 09:17          |     $1.2570 |        $1.4101 | $2.6671 |
| v5, 09:41          |     $1.1564 |        $1.3532 | $2.5096 |

### The effort sweep, as measured on 14 September 2026

The measurement specification section 5.5 asks for first and section 12.1
decision 6 waits on. `low`, `medium` and `high` on the two full-length fixtures
into German, `claude-sonnet-5`, fast lane, prompt `lexicue/system@v3`, with Opus
5 judging the **same deterministic 20-cue stratified sample per file in every
arm**. The `medium` column is this morning's v3 baseline, reused rather than
re-run. Two files, 1,400 cues, 44,580 characters; 40 cues judged per arm, so
**a difference under 0.05 on a judge mean is noise, and is marked below.**

| Both files, 1,400 cues |               `low` |  `medium` |                `high` |
| ---------------------- | ------------------: | --------: | --------------------: |
| Hard metrics           |                pass |      pass |                  pass |
| Repairs, untranslated  |                1, 0 |      1, 0 |                  1, 0 |
| Accuracy               |      4.875 (−0.005) |     4.880 |        4.875 (−0.005) |
| Naturalness            |      4.750 (−0.030) |     4.780 |        4.750 (−0.030) |
| Register               |      5.000 (+0.025) |     4.975 |    4.925 (**−0.050**) |
| Name consistency       |      4.950 (+0.045) |     4.905 |    4.975 (**+0.070**) |
| Output tokens          |      49,321 (−8.1%) |    53,641 | 141,114 (**+163.1%**) |
| Input tokens           |              78,546 |    77,458 |                93,496 |
| Cache reads            |             194,635 |   179,292 |               192,058 |
| Model cost             | $0.7582 (**−3.9%**) |   $0.7886 | $1.7099 (**+116.8%**) |
| Cost per cue           |           $0.000542 | $0.000563 |             $0.001221 |
| Per 1,000 characters   |             $0.0170 |   $0.0177 |               $0.0384 |
| Wall time              |             199.6 s |   215.9 s |    666.0 s (**3.1x**) |
| Judge cost (Opus 5)    |             $0.4575 |   $0.4691 |               $0.4618 |

Per file, where the two differ in shape — a 400-cue drama of short exchanges
and a 1,000-cue comedy:

| `drama/the-signal-box.srt`, 400 cues |   `low` | `medium` |   `high` |
| ------------------------------------ | ------: | -------: | -------: |
| Accuracy                             |    4.85 |     4.81 |     4.80 |
| Naturalness                          |    4.70 |     4.71 | **4.55** |
| Register                             |    5.00 |     4.95 |     4.85 |
| Name consistency                     |    4.95 |     4.81 |     4.95 |
| Reading-speed flags per 1,000 cues   |   247.5 |      255 |      225 |
| Long lines per 1,000 cues            |     165 |      155 |    137.5 |
| Output tokens                        |  15,617 |   16,641 |   47,938 |
| Model cost                           | $0.2304 |  $0.2406 |  $0.5788 |
| Wall time                            |  90.0 s |   98.7 s |  395.4 s |

| `comedy/the-inventory.srt`, 1,000 cues |   `low` | `medium` |  `high` |
| -------------------------------------- | ------: | -------: | ------: |
| Accuracy                               |    4.90 |     4.95 |    4.95 |
| Naturalness                            |    4.80 |     4.85 |    4.95 |
| Register                               |    5.00 |     5.00 |    5.00 |
| Name consistency                       |    4.95 |     5.00 |    5.00 |
| Reading-speed flags per 1,000 cues     |     185 |      207 |     219 |
| Long lines per 1,000 cues              |      65 |       97 |      92 |
| Output tokens                          |  33,704 |   37,000 |  93,176 |
| Model cost                             | $0.5279 |  $0.5480 | $1.1311 |
| Wall time                              | 109.6 s |  117.2 s | 270.6 s |

**`low` holds quality, and saves 3.9% rather than 15%.** Every one of the four
judge axes moves by less than 0.05 — accuracy −0.005, naturalness −0.030,
register +0.025, names +0.045 — which on a 40-cue sample is noise in both
directions, and the hard metrics, the repair count and the untranslated count
are identical. The advisory flags move the right way rather than the wrong one:
reading-speed findings fall on both files and long lines fall by a third on the
1,000-cue file. **So the quality condition sections 5.5 and 6.9 attach to `low`
is met. The saving those sections attach to it is not.** They expect about 15%
of blended model cost; the measurement is 3.9%.

**Why the saving is a quarter of what the specification assumes.** Effort can
only remove thinking, and on this task there is much less of it to remove than
section 5.4's budget implies. The floor is the translated JSON itself: at `low`
the run still emitted 49,321 output tokens for 1,400 cues, and every one of
those cues came back complete and valid, so that volume is irreducible. Dropping
from `medium` to `low` removed 4,320 output tokens — 8.1% of output, and 3.9% of
a bill in which output is 68% of the total. To reach 15% off the total, output
would have had to fall by about 22%. Section 5.4's own output budget for a film
is sound — it models 57,000 tokens where 1,400 measured cues emitted 53,641 at
`medium` — but the share of it that is thinking, and therefore reachable by the
effort setting, is roughly a third of what section 6.9 counts on.

**`high` buys nothing and costs more than double.** Output tokens rise 163% and
the bill rises 117%, for no quality: accuracy and naturalness move by less than
0.05, name consistency gains 0.070 and register _loses_ 0.050. The one visible
change is in the wrong direction — the drama's naturalness falls to **4.55**,
the lowest single reading anywhere in this sweep, on the file whose dialogue is
shortest and quickest. Wall time triples, from 215.9 to 666.0 seconds for the
same 1,400 cues, which is a fast-lane promise (section 3.2) as well as a bill.
**Nothing in this measurement argues for running the product above `medium`.**

**What it means for section 6.9's margin arithmetic.** That section lists effort
`low` first among the levers behind the price, worth "about 15%" of blended
model cost and margins "in the mid fifties"; section 5.5 has the film dropping
from $0.75 toward $0.65 on the same assumption. At 3.9% the film drops to about
**$0.72**, and the margin moves by roughly a point rather than into a new band.
`low` is therefore a real but minor economy, not a pricing lever: if the blind
preference test of section 6.7 ever forces the price toward the cheap tools',
the levers that can actually carry it are the economy lane's discount and the
rate itself, and section 6.9's first bullet should not be counted on for the
difference. **The product's default is left at `medium` in
`packages/harness/src/config.ts`; this is the founder's call, and specification
section 9.8 makes it a configuration edit rather than a deploy.** The case for
moving it is 3.9% at no measured quality cost; the case against is that 3.9% of
the model bill is smaller than the noise in a month's traffic mix, and `medium`
is what every measurement in this README was taken at.

**One thing the sweep could not settle.** The repeated-line advisory reports 5
of 18 repeated lines drifting at `low` and 3 of 18 at `high`, all of them in the
1,000-cue file and all of them radio procedure — "Go ahead, Mrs. Ayres." coming
back as both `Kommen` and `Sprechen Sie`. **There is no `medium` number to
compare them against**: the advisory postdates the v3 baseline run, so that
column is blank rather than zero, and re-running `medium` was not in this
measurement's budget. What the two arms do show is that drift on this file is
present at both ends of the effort range, which points at the prompt rather than
at thinking — `@v3` carries no fixed-rendering mechanism, that having been
reverted with `@v4` and `@v5` — and it is the deterministic half of that work,
still in `packages/harness/src/repeats.ts`, that would fix it. Effort is not the
variable here.

**What the sweep cost.** Two real invocations, $3.39 in total: `low` $1.2157
($0.7582 translation, $0.4575 judge) and `high` $2.1717 ($1.7099 translation,
$0.4618 judge). The `medium` arm cost nothing, being the morning's baseline read
off disk. Results under `.local/evals/2026-09-14T10-27-23-668Z-2026-09-14-de-effort-low/`
and `.local/evals/2026-09-14T10-33-17-222Z-2026-09-14-de-effort-high/`.

One caveat on the cache columns, which does not affect the comparison: the
`medium` baseline ran these two files inside a 13-file run, so the shared
system-prompt entry was already warm when they started, while each of the two
sweep runs paid for it once on its first file — about 3,000 tokens, under a
cent. Per-file cache writes are dominated by each file's own source document,
which is identical in all three arms.

### The density the price was modelled on, as measured on 14 September 2026

`documentary/the-long-meadow.srt` — 300 cues, 12,893 characters, **43.0
characters per cue** — into German on the fast lane, `claude-sonnet-5` at effort
`medium`, three batches at the default batch size. Written for this one
measurement: specification section 5.3 prices a feature film at about 43
characters per cue, and until this file existed nothing in the corpus was within
ten of it. Outputs under `.local/runs/2026-09-14-1755-long-meadow-de/`.

| What                  | Measured                                                         |
| --------------------- | ---------------------------------------------------------------- |
| Model cost            | $0.1936, against $0.37 charged                                   |
| Per 1,000 characters  | $0.0150                                                          |
| Per cue               | $0.000645                                                        |
| Wall time             | 100.0 s for 300 cues, first batch alone then two at once         |
| Tokens                | 17,299 in, 13,336 out                                            |
| Cache                 | 9,099 written **once**, 14,716 read                              |
| Repairs, untranslated | none, none                                                       |
| Character expansion   | 1.097x — 12,893 characters of English, 14,144 of German          |
| Advisory              | 1 cue over 20 characters per second, 49 lines over 42 characters |

Every index line, timing line and inline tag came back identical to the source,
re-parsed and compared cue by cue, and all 300 cues were translated.

**The cost model is 20% optimistic at its own density.** Section 5.3 prices the
film at $0.0125 per 1,000 characters and $0.000536 per cue. This file, at the
section's own 43 characters per cue, came in at **$0.0150 per 1,000 characters
(+20.1%) and $0.000645 per cue (+20.5%)**. The two percentages agree because the
densities agree; at 42.98 against 42.9 they have to. That is the cleanest
statement this repository can make about section 5.3: at the shape it models, it
is a fifth under.

| File                              |    Cues | Chars/cue | Per 1,000 chars |       Per cue |
| --------------------------------- | ------: | --------: | --------------: | ------------: |
| `season/*.srt` (3 files)          |      81 |      25.9 |         $0.0442 |     $0.001142 |
| `comedy/the-lamp-room`            |      38 |      27.9 |         $0.0295 |     $0.000826 |
| `comedy/the-inventory`            |   1,000 |      31.2 |         $0.0175 |     $0.000548 |
| `drama/the-signal-box`            |     400 |      33.3 |         $0.0180 |     $0.000601 |
| **`documentary/the-long-meadow`** | **300** |  **43.0** |     **$0.0150** | **$0.000645** |
| Section 5.3's film, **modelled**  |   1,400 |      42.9 |         $0.0125 |     $0.000536 |

**Three points now separate the two components, which two could not.** Least
squares over the three full-length files gives

```
model cost  =  $0.0088 per 1,000 characters  +  $0.000277 per cue
```

and predicts all three within 5%. **At 43 characters per cue the per-cue term is
42% of the cost; at 31 it is 51%.** That is the measurement the per-cue component
of the rate exists for, and it is the first one taken rather than inferred: the
signal box and the inventory alone fit a _negative_ per-cue term, because 33.3
and 31.2 are too close to tell the two apart.

Extrapolated, section 5.3's own film — 1,400 cues, 60,000 characters — costs
**about $0.92, not $0.75**.

**What that does to the recommendation, and what it does not.**

| Section 5.3's film, fast lane | Old rates |   Under A |
| ----------------------------- | --------: | --------: |
| Price                         |     $1.80 |     $1.72 |
| Margin at the modelled $0.75  |     50.8% |     48.8% |
| Margin at the measured $0.92  | **41.6%** | **39.1%** |

**A's neutrality on the film holds.** That was the claim the single run was meant
to test, and it survives: the film gives up 2.4 points moving to A at the
measured cost, against the 2.0 points the modelled table showed. Neutrality is a
difference of two numbers that share a cost term, so being wrong about the cost
by a fifth moves both sides together. **Nothing here argues for changing the
rates, and they have not been changed.**

**Section 5.3's cost column does not hold, and section 6.4's margins follow it
down.** The specification's fast-lane table prints 43 to 49% across its shapes;
at the measured cost those are nearer **34 to 40%**. This is the founder's to
decide what to do about — it is a specification correction, not a rate change,
and the rate that would fix it is a different conversation from the one just
settled.

**A did the job it was chosen for.** Margins at the new rates on every measured
shape, worst first:

| Shape                         | Lane    | Price | Model cost |    Margin |
| ----------------------------- | ------- | ----: | ---------: | --------: |
| `documentary/the-long-meadow` | fast    | $0.37 |    $0.1936 | **33.7%** |
| `drama/the-signal-box`        | fast    | $0.46 |    $0.2406 |     35.3% |
| Section 5.3's film, measured  | fast    | $1.72 |      $0.92 |     39.1% |
| `comedy/the-inventory`        | fast    | $1.12 |    $0.5480 |     42.5% |
| `documentary/the-long-meadow` | economy | $0.25 |    $0.0842 |     48.4% |

The spread across the measured full-length shapes was 28.1% to 42.4% under the
old rates and is **33.7% to 42.5%** under A: the floor came up by more than five
points, which is exactly what the change was for. The economy figure is the
signal box's measured 43.5%-of-fast ratio applied to this file; this run was
fast-lane only.

**One thing worth the founder's eye.** The long meadow is the only measured file
that got _cheaper_ under A — 39 cents to 37 — and it therefore earns less than
it used to, 36.8% down to 33.7%. That is the same mechanism that makes the
feature film 8 cents cheaper, working as designed: A shifts charge from
characters onto cues, and a sparse file has fewer cues per character. The
consequence is that **the worst-earning shape is now the sparse one rather than
the dense one.** It is a better worst case than the 28.1% it replaced, and no
measurement here suggests moving the rate again; it is simply no longer true
that dense files are where the margin risk sits.

**The translation, read.** The motif — "The water has to keep moving.", six
times across all three batches — came back as `Das Wasser muss in Bewegung
bleiben.` every time, with no variation. Winifred Sallis, Tobias Reed, Marguerite
Okonkwo, Alban Pryce, Wraycombe, Pennyquick and the Ashe are spelled identically
throughout. The water-meadow vocabulary, which is the point of the fixture and
whose everyday senses are all wrong, came back right and came back consistent: a
`drowner` is a `Wässerer`, a `carrier` a `Wassergraben` against a `drain`'s
`Abzugsgraben` and a `main`'s `Hauptgraben`, a `hatch` a `Schütz`. One miss, and
it is the kind this fixture exists to catch: "That sheet has a name of its own"
is the sheet of water, and it came back as `Tuch`, a cloth.

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

Call it **$13 to $18**, and $10 to $12 with `--no-judge`. **The judging line is
now measured and it is too low**: one target cost $1.33 to $1.41 to judge on 14
September 2026, so eight targets is nearer $11 than $4, and the total nearer
$20 to $24. The section above has the numbers. What is measured in
that: the signal box at $0.2439, the season at $0.0863, the lamp room at
$0.0321, and Bulgarian costing 1.06 times German over the same four files. What
is modelled: the 1,000-cue file by interpolation, the seven short files at the
lamp room's cost, and Greek, Japanese and Hindi at 1.17 to 1.28 times German on
section 5.2's expansion factors, which are themselves estimates. The judge
figure assumes it reads every file whole, which `renderJudgeRequest` does.

**`pnpm evals run` without `--fake` costs this much and needs the founder's
approval.** Nobody has run it.

### What the measurements say about the price, as at 14 September 2026

**Decided, and applied.** The founder accepted option A below on 14 September
2026, and it is now the product's default rate table: **1 cent per 1,000
characters plus 8 cents per 100 cues on the fast lane, 1 cent plus 4 cents on
the economy lane, the 10-cent floor unchanged on both.** It replaces the 3 and
2 cents per 1,000 characters of specification section 6.1, which had no per-cue
component. The rest of this section is the measurement and the arithmetic the
decision rests on, kept as the record of why.

Everything that quotes a price moved with it in one commit: `packages/pricing`'s
defaults, the corpus manifest's expected prices, the SSM parameter defaults in
`infra/`, the lane cards in the app and the browser suite that reads them, and
the specification's own sections 5.3, 6.1, 6.2, 6.4 and 6.9, which the founder
amended in parallel. `evals/src/evals.test.ts` prices all thirteen fixtures
against the manifest, so no published price can move again without that file
moving with it.

Model cost below is the 14 September v3 corpus run into German, Sonnet 5 at
effort `medium`, fast lane; the economy figures are the two real economy runs.
Card fee is the $10 top-up's 5.9% share and AWS is $0.02 to $0.03 a file, both
as specification section 6.4 assumes. Economy cost is measured for the season
and the signal box; for the other shapes it is that file's fast cost times the
**43.5%** the signal box measured on both lanes, which is marked where it is
used.

#### Cost follows cues; the price follows characters

| Shape                            |  Cues |  Chars | Chars/cue | Model cost | Per 1,000 chars |   Per cue |
| -------------------------------- | ----: | -----: | --------: | ---------: | --------------: | --------: |
| `comedy/the-lamp-room.srt`       |    38 |  1,062 |      27.9 |    $0.0314 |         $0.0295 | $0.000826 |
| `season/*.srt`, 3 episodes       |    81 |  2,096 |      25.9 |    $0.0925 |         $0.0442 | $0.001142 |
| `drama/the-signal-box.srt`       |   400 | 13,339 |      33.3 |    $0.2406 |         $0.0180 | $0.000601 |
| `comedy/the-inventory.srt`       | 1,000 | 31,241 |      31.2 |    $0.5480 |         $0.0175 | $0.000548 |
| Section 5.3's film, **modelled** | 1,400 | 60,000 |      42.9 |    $0.7500 |         $0.0125 | $0.000536 |

Against the model the price was built on, `the-signal-box.srt` costs **44% more
per 1,000 characters but 12% more per cue**, and `the-inventory.srt` **40% more
per 1,000 characters but 2% more per cue**. That is the whole argument: the JSON envelope, the id and the per-cue overhead are the
same size whether a cue holds four words or fourteen, so a dense file costs more
to produce per character and earns less.

**The caveat that decided how far to go, now settled.** The sparse end of that
table was a model, not a measurement: the two measured full-length files sat at
33.3 and 31.2, too close to separate the per-cue and per-character components by
regression. `documentary/the-long-meadow.srt` is the third point, at 43.0, and
it cost 19 cents to make. The next section has it.

#### Margin at the rates this replaced, per measured shape

| Shape                        | Lane    | Price | Card fee |   Model |   AWS |  Gross |    Margin |
| ---------------------------- | ------- | ----: | -------: | ------: | ----: | -----: | --------: |
| `the-lamp-room.srt`          | fast    | $0.10 |   $0.006 | $0.0314 | $0.02 | $0.043 |     42.7% |
| `season/*.srt`, 3 episodes   | fast    | $0.30 |   $0.018 | $0.0925 | $0.06 | $0.130 |     43.3% |
| `season/*.srt`, 3 episodes   | economy | $0.30 |   $0.018 | $0.0263 | $0.06 | $0.196 | **65.3%** |
| `the-signal-box.srt`         | fast    | $0.41 |   $0.024 | $0.2406 | $0.03 | $0.115 | **28.1%** |
| `the-signal-box.srt`         | economy | $0.27 |   $0.016 | $0.1061 | $0.03 | $0.118 |     43.7% |
| `the-inventory.srt`          | fast    | $0.94 |   $0.055 | $0.5480 | $0.03 | $0.307 | **32.6%** |
| Section 5.3's film, modelled | fast    | $1.80 |   $0.106 | $0.7500 | $0.03 | $0.914 |     50.8% |

**That price under-earned on dense, short-cue files, and that was the only
place it under-earned.** Section 6.4 promises 45 to 48% blended and 51% on the
film. The two measured full-length files return **28.1%** and **32.6%** — 22.7
and 18.2 points short of the film's margin on the same rate card. In money, to
earn what the film earns, `the-signal-box.srt` would have to be priced at 62
cents rather than 41 (**+52%**) and `the-inventory.srt` at $1.33 rather than
$0.94 (**+42%**); the gross left on the table is 20.2 and 37.1 cents a file. The
small end is fine: the 10-cent floor holds the lamp room at 42.7% and the season
at 43.3%, which is the band section 6.4 designed for.

**The economy lane is the opposite problem.** `drama/the-signal-box.srt` is the
one file run on both lanes: $0.2439 fast against $0.1061 economy, so economy
costs **43.5% of fast** where section 5.3 models 77%. Priced at two thirds of
fast, the cheaper lane earns a better margin than the expensive one on the same
file — 43.7% against 28.1%. (The season's economy run came in at 30.5% of fast,
but its output-token count is confounded; the signal box is the number to use.)

#### Three alternatives

Rates are written `chars-per-1,000 / cents-per-100-cues / floor`.

**A. A per-cue component, sized to leave the film where it is.** Fast
`1 / 8 / 10`, economy `1 / 4 / 10`.

| Shape                      |    Fast today |      Fast under A | Economy today | Economy under A |
| -------------------------- | ------------: | ----------------: | ------------: | --------------: |
| `the-lamp-room.srt`        | $0.10 · 42.7% |     $0.10 · 42.7% | $0.10 · 60.5% |   $0.10 · 60.5% |
| `season/*.srt`, 3 episodes | $0.30 · 43.3% |     $0.30 · 43.3% | $0.30 · 65.3% |   $0.30 · 65.3% |
| `the-signal-box.srt`       | $0.41 · 28.1% | **$0.46 · 35.3%** | $0.27 · 43.7% |   $0.30 · 48.7% |
| `the-inventory.srt`        | $0.94 · 32.6% | **$1.12 · 42.5%** | $0.63 · 51.5% |   $0.72 · 56.8% |
| Section 5.3's film         | $1.80 · 50.8% |     $1.72 · 48.8% | $1.20 · 64.4% |   $1.16 · 63.4% |

Every file at the floor is unchanged, the headline film gets 8 cents _cheaper_,
and the two shapes that under-earn gain 7.2 and 9.9 points.

**B. A higher floor.** Fast `3 / 0 / 20`, economy `2 / 0 / 15`. It doubles the
price of every small file — the lamp room $0.10 to $0.20 at 68.4%, the season
$0.30 to $0.60 — and does **nothing at all** for the two shapes that under-earn,
which are already far above any plausible floor. It solves a problem the
measurements did not find.

**C. A wider economy discount, funded by the measured 43.5%.** Fast unchanged,
economy `1 / 3 / 10`. The film's economy price falls from $1.20 to $1.02 (−15%)
and still returns 59.2%; the signal box goes to $0.26 at 41.8%. Note that a
discount between one third and two thirds is **not expressible without the
per-cue component**: whole cents per 1,000 characters jump straight from 2 to 1,
and a flat 1 cent loses money on the signal box — $0.14 charged against $0.144
of model cost, card fee and AWS. The per-100-cues component is what gives the rate card sub-cent
resolution — the lever section 6.9 assumed when it wrote "2.25 cents per 1,000".

#### Recommendation, and what was done

**A was adopted.** It lifts the two measured full-length files from 28.1% and
32.6% margin to 35.3% and 42.5%, leaves every file at the 10-cent floor priced
exactly as it was, and makes the specification's own feature film 8 cents
_cheaper_ rather than dearer. The economy lane keeps the discount it has rather
than widening it: 4 cents per 100 cues against the fast lane's 8 holds it at
31.7% to 32.6% off across every shape section 6.1 prices, which is where it sat
before. Option C's wider discount was not taken.

On the whole corpus the change is **$2.45 to $2.68 on the fast lane and $2.00 to
$2.12 on the economy lane**. Eleven of the thirteen fixtures are at the floor
and did not move a cent; the entire difference is `drama/the-signal-box.srt`
(41 to 46 cents fast, 27 to 30 economy) and `comedy/the-inventory.srt` (94 cents
to $1.12 fast, 63 to 72 cents economy).

**The one assumption it rested on has now been measured**, which was the
condition attached to the recommendation: A's neutrality on the feature film
came from section 5.3's _modelled_ $0.75 at about 43 characters per cue, a
density no fixture had. `documentary/the-long-meadow.srt` was written for it
and run for real on 14 September 2026; the section below reports what it cost,
and the short version is that **A's neutrality on the film holds and section
5.3's cost column does not**.

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
- The eval corpus is fourteen hand-written files, 2,040 cues and 67,110
  characters, against the twenty files of 300 to 2,600 cues section 10.4 asks
  for. Eleven of them are 23 to 39 cues and cover every _shape_ — three genres,
  a hearing-impaired edition, three formats, three source languages, a
  three-episode season. The three full-length ones — `drama/the-signal-box.srt`
  at 400 cues, `comedy/the-inventory.srt` at 1,000 and
  `documentary/the-long-meadow.srt` at 300 — cover the length and the density:
  four, nine and three batches, priced by the metered rate rather than the
  10-cent floor, written so a recurring line falls in every batch, and spanning
  25.9 to 43.0 characters per cue, which is the spread the cost model is fitted
  on. What is still short is breadth, and a file at the 2,600-cue end.
  `evals/README.md` has the detail.

## Stripe, and what has not been exercised

Specification section 6.6's flow is written and tested as far as a repository
with no Stripe account can be: `packages/core/src/billing.ts`, with 15 tests in
`billing.test.ts` and five more over real HTTP in `packages/dev-api`.

**Nothing here has ever talked to Stripe.** `.env` carries the model key and
nothing else, so the top-up route falls back to the local checkout screen and
`POST /api/billing/webhook` refuses with a sentence naming what to set. The
split is deliberate:

| Part                                            | State                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Webhook signature verification                  | **Written out and tested properly.** No key is needed: a test signs a body itself.        |
| Idempotent credit, keyed on the Stripe event id | **Tested.** A redelivered event credits nothing, which is the whole point of the marker.  |
| `charge.refunded` taking unspent balance back   | **Tested.** Never below zero, never out of the free grant.                                |
| Reconciliation                                  | **Tested** against a fake Stripe: the ledger invariant, and sessions that never credited. |
| Creating a Checkout Session                     | **Never run.** `HttpStripeClient` names the endpoint and the parameters and nothing more. |
| The Stripe CLI forwarding real webhooks         | **Never run.**                                                                            |

The signature is written out rather than imported on purpose. There is no
`stripe` package here: this product uses three calls of that API, the SDK's
value is the breadth it wraps, and a megabyte of unexercised dependency would
not have made the untested part any less untested. What it would have done is
hide the one piece worth reading — `HMAC-SHA256` over `{timestamp}.{body}`,
compared in constant time against the `v1` values in the header, inside a
five-minute tolerance — behind a function call. The raw body matters: a handler
that parses JSON first and re-serialises it fails every time, and one that
verifies the re-serialised body would accept a forgery. There is a test for
exactly that.

**What the founder has to do to exercise it**, all in test mode:

1. In the Stripe dashboard, in **test mode**, copy the secret key
   (`sk_test_…`) into `STRIPE_SECRET_KEY` in `.env`.
2. Install the Stripe CLI and forward webhooks to the local API:

   ```sh
   stripe login
   stripe listen --forward-to localhost:5174/api/billing/webhook
   ```

   It prints a signing secret (`whsec_…`); put that in
   `STRIPE_WEBHOOK_SECRET` in `.env` and restart `pnpm dev`.

3. Click a top-up in the app. It will now open Stripe's hosted page instead of
   the local checkout screen; pay with `4242 4242 4242 4242`. The balance
   should move when the forwarded webhook lands.
4. Then try the two things only a real Stripe can show:
   `stripe events resend <event-id>` must credit nothing the second time, and a
   refund issued in the dashboard must take the unspent balance back and leave
   the $2.50 grant alone.

**Expect to find something wrong in step 3 or 4.** The Checkout Session call is
the one part of this that nobody has run.

One thing the specification does not have and this needed: a fifth ledger
reason. Section 7.4 lists `topup`, `grant`, `charge` and `refund`, and section
6.6 requires taking balance _back_ when a card payment is refunded. Recording
that as a `refund` would put "Refund −$5.00" in a money list where `refund`
means the opposite, so there is now a `reversal` reason and the wallet screen
calls it "Payment reversed".

## The end-to-end suite

Specification section 10.3 asks for Playwright against staging after every
deploy: sign in, upload a fixture, translate, download, verify the file and the
charge. Nothing is deployed, so the subject is the mock backend — the whole
product in the browser, no key, no network, no spend — and everything it
exercises is real code: the parser, the price function, the wallet arithmetic,
the refund and the harness's structural guarantee.

```sh
pnpm --filter web exec playwright install chromium   # once per machine
pnpm e2e                                             # 9 tests, about 20 seconds
pnpm --filter web e2e --headed                       # to watch it happen
```

`apps/web/playwright.config.ts` builds the mock app with `vite build --mode
mock` and serves it with `vite preview` on port 4183, so the tests drive the
production bundle that would ship rather than a dev server, on a port of their
own: a `pnpm dev` already running on 5173 is never borrowed and never disturbed.
The specs are `apps/web/e2e/*.e2e.ts`, they address the page by role and
accessible name rather than by CSS class, and they assert on the downloaded
bytes with `@lexicue/subtitles` — same cue count, every timing line identical to
the source.

The nine are: the section 10.3 smoke test; the automatic refund of a failed
file; the top-up offered instead of a refusal, through the mock checkout; the
economy lane, with its notice and its own download; three episodes at once and
the "Download all" zip, unpacked and parsed file by file; a file that is not a
subtitle file explaining itself in its row and being removed on its own; a
dropped zip unpacked in the browser; the same-language refusal of section 3.3;
and the demo's history and reset.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to
`main`. It is two jobs on `ubuntu-latest`, side by side.

`check` is the original: check out, install pnpm, install Node.js 24,
`pnpm install --frozen-lockfile`, then the same four commands "Getting started"
lists above — `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`,
`pnpm --filter web build` — in that order. Keeping the workflow a thin wrapper
over the package scripts is what makes a red run reproducible locally in one
command.

`e2e` installs dependencies the same way, adds `playwright install --with-deps
chromium`, and runs `pnpm --filter web e2e`. On failure — and only on failure —
it uploads Playwright's HTML report, with the trace of the retried run in it, as
an artifact named `playwright-report`. Ten minutes is its whole budget; it takes
about two.

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
| `cdk synth`                 | Covered, and then some: `pnpm test` synthesises all six stacks of `infra/` for dev, staging and prod and asserts them, which is strictly more than synthesising.                    |
| `cdk diff` against staging  | Needs a deployed stack and a read-only OIDC role in an AWS account. There is no account.                                                                                            |
| Dependency audit            | `pnpm audit --audit-level high` passes on this commit but is not a workflow step: nobody has decided yet whether a newly published advisory should block an unrelated pull request. |
| Secret scanning             | GitHub's own secret scanning and push protection are repository settings rather than workflow steps, and the founder has to turn them on.                                           |

The founder pushes, so this workflow has never run on GitHub. What has been
done is to validate it as YAML against the SchemaStore GitHub workflow schema,
check `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6` and
`actions/upload-artifact@v7` against the current major version of each, and run
both jobs' commands locally on this commit, from a fresh clone installed with
`--frozen-lockfile`. Two steps of the `e2e` job could not be: `--with-deps`
installs Linux system libraries and this is Windows, so the browser came from a
plain `playwright install chromium`, and uploading the report is an action
rather than a command.

## Test counts and coverage, as measured

750 tests in 40 files, all offline: nothing in the suite touches the network or
the key, and the local development API is driven over real HTTP against the
deterministic fake model client.

| Package              | Statements |   Branches |  Functions |      Lines |
| -------------------- | ---------: | ---------: | ---------: | ---------: |
| `packages/subtitles` |     99.03% |     96.64% |       100% |     98.82% |
| `packages/pricing`   |       100% |       100% |       100% |       100% |
| `packages/harness`   |     97.36% |     88.94% |     97.05% |     98.65% |
| `packages/shared`    |     99.18% |     84.85% |       100% |       100% |
| `packages/core`      |     90.09% |     76.64% |     92.98% |     91.79% |
| `packages/cli`       |     91.57% |     74.24% |       100% |     92.81% |
| `packages/dev-api`   |     79.45% |     73.46% |     85.71% |     81.29% |
| `evals`              |     90.49% |     77.06% |     92.31% |     93.36% |
| `infra`              |     77.62% |     66.18% |     53.06% |     79.27% |
| **All**              | **91.99%** | **81.88%** | **92.36%** | **93.45%** |

`packages/dev-api` and `infra` are the lowest, and deliberately so. What is
uncovered in `dev-api` is its executable entry points (`bin.ts`, `dev.ts`),
which start processes, and the error paths that only a real model outage
reaches. What is uncovered in `infra` is every Lambda `handler` export and both
AWS store adapters, because those are the parts that need an AWS account and
therefore fail closed on purpose — the logic behind them, `routeRequest` and
`consume`, is tested. That is also why its function coverage is the lowest
number in the table: the uncovered functions are almost all one-line stubs that
throw.

Specification section 10.1 sets a 95% target on `packages/subtitles` and
`packages/pricing`; both are past it and the threshold is enforced by
`pnpm test:coverage`.
