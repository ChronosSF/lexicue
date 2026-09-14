# Evaluation

The instrument for every prompt, effort, batch-size and lane decision
(specification section 10.4). It exists before the web app does, and it has a
commercial job as well as a technical one: proving the quality difference that
justifies the price premium over the cheap tools in section 6.7.

## The corpus

`evals/corpus` holds fourteen files, 2,040 cues and 67,110 characters of
dialogue, all written for this project. Nothing in it is copied from a real
film, a real subtitle release, or anyone else's work, so the whole corpus is
safe to redistribute. `manifest.json` describes each file and says what it
exists to cover.

| Area                     | Files                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Comedy                   | `comedy/the-lamp-room.srt`                                                                                                                                                     |
| Drama                    | `drama/the-last-tender.srt`                                                                                                                                                    |
| Documentary              | `documentary/the-keepers.srt`                                                                                                                                                  |
| Hearing-impaired edition | `hearing-impaired/the-lamp-room.hi.srt` — bracketed sounds, speaker labels, music notes and lyrics                                                                             |
| Non-English sources      | `german/der-leuchtturm.srt`, `spanish/el-faro.srt`                                                                                                                             |
| The other two formats    | `formats/the-lamp-room.microdvd.sub`, `formats/the-lamp-room.subviewer.sub` — the same dialogue as the comedy, so all three must price identically                             |
| A three-episode season   | `season/skerry-point-s01e0{1,2,3}.srt` — Marta and Ivo throughout, Petar introduced late in episode two, and three running jokes (the gulls, the stairs, the Light's opinions) |
| Full length              | `drama/the-signal-box.srt` (400 cues, four batches), `comedy/the-inventory.srt` (1,000 cues, nine batches) and `documentary/the-long-meadow.srt` (300 cues, three) — see below |

**Scale.** The specification asks for about twenty files of 300 to 2,600 cues.
Eleven of these thirteen are 23 to 39 cues, which is one batch each: they cover
every _shape_ the specification lists, but a single-batch file can never read
the prompt cache and never amortises a file's fixed cost, so it can say nothing
about the cost model of specification section 5.3.

The other three exist for exactly that. **`drama/the-signal-box.srt`** is 400
cues and 13,339 characters, four batches at the default batch size of 120;
**`comedy/the-inventory.srt`** is 1,000 cues and 31,241 characters, nine
batches; **`documentary/the-long-meadow.srt`** is 300 cues and 12,893
characters, three batches. All three are priced by the metered rate rather than
the 10-cent floor, which no other fixture is. All three were written for the
seams: a line that recurs in _every_ batch of the file ("The line doesn't care."
nine times; "Count it twice, say it once." fifteen times; "The water has to keep
moving." six times), names that appear in some batches and not others, fixed
terms whose everyday meanings are wrong (the railway "tablet" is a token, not a
pill; a water meadow's "drowner" is the man who floods it and its "carriers" are
channels), and a running count that is deliberately incorrect until the last
batch. A translation that loses the thread between parallel requests shows up in
those, and nowhere else in this corpus.

**Density.** The three differ in characters per cue as well as in length, and
that is deliberate. `the-signal-box.srt` is 33.3 and `the-inventory.srt` 31.2,
which is a real shape — quick, dense dialogue — but too close together to tell
the per-cue and per-character halves of the model cost apart.
`the-long-meadow.srt` is **43.0**, which is what specification section 5.3
prices a feature film at, and it is the third point that separates them. The
root `README.md` has the fit and what it did to the price.

Timings were laid out from the written dialogue at a spread of reading speeds,
with pauses inside scenes and about nine seconds between them, which puts the
400-cue file at 28 minutes and the 1,000-cue file at 1 hour 12. The dialogue
itself, which is the part that gets translated, was written by hand.

`the-long-meadow.srt` is timed more generously than the other two, at about 12
characters a second with its lines broken at the 42-character convention, which
leaves room for German to expand. It flags 1 reading-speed finding and 1 long
line where `the-signal-box.srt` flags 102 and 66: the advisory counts on that
file are a property of how tightly it was timed, not of the translation, and the
newer fixture is what a professionally timed source looks like.

What is still missing against section 10.4 is breadth rather than length: it
asks for about twenty files, and a file at the 2,600-cue end.

## Running it

Against the fake model and the fake judge, offline and free:

```sh
pnpm evals run --fake --to de,bg --sample 6
```

Against the real model, which costs money:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
pnpm evals run --to de,es,fr,pl,bg,el,ja,hi
```

A full run is the whole corpus into eight languages plus judging. **On this
corpus that is projected at $13 to $18, or $10 to $12 with `--no-judge`**, from
the measured per-file costs in the root `README.md`; nobody has run it, and it
needs the founder's approval. **The judging half of that projection is now
measured and is too low**: one target cost $1.33 to $1.41 to judge on 14
September 2026, so eight targets is nearer $11 than the $4 projected, and the
total nearer $20 to $24. One judged target costs about $2.40 all in. Specification section 10.4 budgets $25 to $35,
which does not reconcile with its own corpus and targets — see
`apps/web/README.md`. `pnpm evals run --help` lists
every flag; `--no-judge` gives a structural and cost run with no judge spend,
`--lane economy` runs the Message Batches path, and `--effort <level>` sets the
translation model's thinking effort, refusing a level the harness cannot send
and a model the capability table says rejects the field.

`--only` narrows the corpus and takes a comma-separated list, which is how a
measurement run names several files in one invocation:

```sh
pnpm evals run --to de --effort low \
  --only drama/the-signal-box.srt,comedy/the-inventory.srt \
  --out .local/evals --label 2026-09-14-de-effort-low
```

One invocation rather than two per arm is deliberate: the files of a run share a
process and the cached system prefix, so measuring them separately would put a
cold cache in one arm and a warm one in the other and call the difference
effort.

**Reading a `--fake` run.** The fake model wraps English dialogue in
guillemets. That is a valid structural translation, so every hard metric passes,
but for a target in a non-Latin script the script check correctly reports every
cue as untranslated. A `--fake` run tells you the harness and the runner work;
it says nothing at all about translation quality.

## What is measured

**Hard metrics — any failure fails the run**

- Structural fidelity: the output re-parses with the same cue count and the same
  index and timing lines, byte for byte.
- Tag preservation: the same multiset of inline tags and control codes per cue.
- Coverage: every cue of the input is a cue of the output.
- The price charged equals the price a preview would have shown from the source.
- Every fixture prices exactly as `corpus/manifest.json` records it, on both
  lanes, under the default rate table: $3.05 for the corpus on the fast lane and
  $2.37 on the economy lane, at the rates adopted on 14 September 2026. The
  manifest carries each file's cue count, character count and expected price, so
  a change to the parser, the price function or the rate table has to change
  that file too — nothing may move a published price by accident.

**Advisory metrics**

Reading-speed and line-length flags per thousand cues, untranslated cues,
repairs the harness had to make, wall time, token usage, model cost, and the
share of prefix tokens served from the cache rather than written to it — which
is how the economy lane's real cache-hit rate gets measured.

**Repeated lines.** `packages/harness/src/repeats.ts` finds every cue text the
source repeats word for word — over one file, and over a whole upload for a
catchphrase said once an episode — and `measureRepeatedLines` reports how many
distinct renderings each came back with. `summary.md` gets a "Repeated lines"
section naming any that drifted. It is advisory and never fails a run: a motif
rendered two ways is a quality fault, not a structural break.

Two things it deliberately does not do. It compares the words with markup
stripped, because tag preservation is a hard metric and the 400-cue fixture says
its motif three times in italics and six times not; comparing the tags too would
report a perfect run as drift. And it groups only **verbatim** repeats: the
season's "Write that in the log." and "Write it in the log." are different
sentences, and a faithful translation is free to render them differently.

**The model under test**

Claude Sonnet 5, on both lanes. Haiku 4.5 was measured against it on 11
September 2026 and is not an option for this product: it renders the season's
own location three ways in three episodes, leaves screen text in English and
lets the running joke drift. The root `README.md` carries the numbers and the
decision. `--model` exists for measuring a future model, not for choosing a
cheaper one.

**Quality**

An LLM judge scores a stratified sample of cues from 1 to 5 on accuracy,
naturalness, register and name consistency against the frozen rubric in
`src/rubric.ts`. The judge is Claude Opus 5, a more capable model than the one
under test; it is eval-only spend and never runs in the product. The season adds
a cross-episode consistency check, in two halves: a structural one that needs no
model, and the judge reading all three episodes for names, terms and forms of
address that drift.

The structural half takes each episode's **source** alongside its translation,
and only judges the episodes whose source actually contains the term. An episode
that never names a character cannot render that character inconsistently, and
reporting it as drift is a false positive — which is what it did on 14 September
2026, for both Ivo and Petar, until it was fixed. A finding now needs a
disagreement: some episodes that use the name render it the fixed way and some
do not.

## The effort setting, as measured on 14 September 2026

**`low` holds quality and saves 3.9%; `high` costs 117% more and buys nothing.**
The sweep ran `low` and `high` on the two full-length fixtures into German,
prompt `@v3`, fast lane, against the morning's `medium` v3 baseline reused
rather than re-run, with the judge scoring the same deterministic 20-cue sample
per file in every arm. Forty cues per arm, so a mean moving less than 0.05 is
noise.

| Both files, 1,400 cues |           `low` | `medium` |            `high` |
| ---------------------- | --------------: | -------: | ----------------: |
| Accuracy               |  4.875 (−0.005) |    4.880 |    4.875 (−0.005) |
| Naturalness            |  4.750 (−0.030) |    4.780 |    4.750 (−0.030) |
| Register               |  5.000 (+0.025) |    4.975 |    4.925 (−0.050) |
| Name consistency       |  4.950 (+0.045) |    4.905 |    4.975 (+0.070) |
| Output tokens          |  49,321 (−8.1%) |   53,641 | 141,114 (+163.1%) |
| Model cost             | $0.7582 (−3.9%) |  $0.7886 | $1.7099 (+116.8%) |
| Wall time              |         199.6 s |  215.9 s |    666.0 s (3.1x) |

**The recommendation for the founder.** `low` is safe on quality — all four axes
inside noise, hard metrics identical, and the advisory flags slightly better —
but it is worth 3.9%, not the 15% specification sections 5.5 and 6.9 assume,
because effort can only remove thinking and the translated JSON is a floor: at
`low` the run still emitted 49,321 output tokens for 1,400 cues, all of them
valid. `high` is refuted outright: 163% more output tokens, 117% more cost, three
times the wall time, register down 0.050 and the drama's naturalness down to
4.55. **The product default stays `medium` in `packages/harness/src/config.ts`
until the founder decides**; the root `README.md` carries the per-file tables,
the arithmetic and what it does to section 6.9's margins.

## Results

`pnpm evals run` writes a folder under `evals/results` named for the run's
timestamp and model, holding `result.json` and a `summary.md` that a reviewer
can read in a pull request. Committing those folders is what makes a regression
visible in review. A measurement run that is not a regression check belongs in
`.local/` instead, which is git-ignored: the three judged prompt runs and both
arms of the effort sweep are there, named in the root `README.md`.

## What the corpus costs, and what it earns

The per-file model cost and the margin at the rates in force are in the root
`README.md`, under **"What the measurements say about the price"**. The short
version: cost tracks cues more closely than characters, and until 14 September
2026 the price metered characters only, so the two full-length fixtures returned
28.1% and 32.6% margin where the specification's own film shape returned 50.8%.

**The rates changed on 14 September 2026** to 1 cent per 1,000 characters plus
8 cents per 100 cues on the fast lane and 1 cent plus 4 cents on the economy
lane, floor unchanged at 10 cents. Those two fixtures now return 35.3% and
42.5%; every other fixture is at the floor and did not move a cent. The
thirteen files that existed then cost $2.68 on the fast lane, up from $2.45;
`documentary/the-long-meadow.srt` takes the fourteen to $3.05.

## Still to do

- The rest of the breadth section 10.4 asks for: about twenty files, and one at
  the 2,600-cue end. Two full-length fixtures now exist; see **Scale** above.
- **Done.** A full-length fixture at 43 characters per cue, which is what
  specification section 5.3 models the price on.
  `documentary/the-long-meadow.srt` was written for it and run for real on
  14 September 2026 for 19 cents. It found the cost model a fifth under at its
  own density — $0.0150 per 1,000 characters against a modelled $0.0125 — and
  confirmed the rate change that was waiting on it. The root `README.md` has the
  numbers.
- The blind pairwise preference test against the cheap tools of specification
  section 6.7, which decides whether the fast lane keeps its premium. It needs
  native speakers, not code.
- **Done.** The effort sweep (`low`, `medium`, `high`) was run on 14 September
  2026 and has its own section below; `--effort` is now a flag rather than a
  config override in TypeScript.
- **Done, three times over.** Judged runs of the whole corpus into German were
  made on 14 September 2026 against `lexicue/system@v3`, `@v4` and `@v5`. The
  root `README.md` carries the axis-by-axis table. The prompt is back at `@v3`:
  neither replacement held every judge axis at or above the baseline while
  staying inside the 5% cost ceiling.
- A judged run into any target but German. The effort sweep was the other half
  of this entry and is now done: effort is not the variable the German prompt
  runs suggested it might be, and the section above says what it is worth.
