# Evaluation

The instrument for every prompt, effort, batch-size and lane decision
(specification section 10.4). It exists before the web app does, and it has a
commercial job as well as a technical one: proving the quality difference that
justifies the price premium over the cheap tools in section 6.7.

## The corpus

`evals/corpus` holds thirteen files, 1,740 cues and 54,217 characters of
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
| Full length              | `drama/the-signal-box.srt` (400 cues, four batches) and `comedy/the-inventory.srt` (1,000 cues, nine batches) — see below                                                      |

**Scale.** The specification asks for about twenty files of 300 to 2,600 cues.
Eleven of these thirteen are 23 to 39 cues, which is one batch each: they cover
every _shape_ the specification lists, but a single-batch file can never read
the prompt cache and never amortises a file's fixed cost, so it can say nothing
about the cost model of specification section 5.3.

The other two exist for exactly that. **`drama/the-signal-box.srt`** is 400
cues and 13,339 characters, four batches at the default batch size of 120;
**`comedy/the-inventory.srt`** is 1,000 cues and 31,241 characters, nine
batches. Both are priced by the metered rate rather than the 10-cent floor,
which no other fixture is. Both were written for the seams: a line that recurs
in _every_ batch of the file ("The line doesn't care." nine times; "Count it
twice, say it once." fifteen times), names that appear in some batches and not
others, fixed terms whose everyday meanings are wrong (the railway "tablet" is
a token, not a pill), and a running count that is deliberately incorrect until
the last batch. A translation that loses the thread between parallel requests
shows up in those, and nowhere else in this corpus.

Timings were laid out from the written dialogue at a spread of reading speeds,
with pauses inside scenes and about nine seconds between them, which puts the
400-cue file at 28 minutes and the 1,000-cue file at 1 hour 12. The dialogue
itself, which is the part that gets translated, was written by hand.

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
needs the founder's approval. Specification section 10.4 budgets $25 to $35,
which does not reconcile with its own corpus and targets — see
`apps/web/README.md`. `pnpm evals run --help` lists
every flag; `--no-judge` gives a structural and cost run with no judge spend,
`--only comedy/` narrows the corpus, and `--lane economy` runs the Message
Batches path.

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

**Advisory metrics**

Reading-speed and line-length flags per thousand cues, untranslated cues,
repairs the harness had to make, wall time, token usage, model cost, and the
share of prefix tokens served from the cache rather than written to it — which
is how the economy lane's real cache-hit rate gets measured.

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

## Results

`pnpm evals run` writes a folder under `evals/results` named for the run's
timestamp and model, holding `result.json` and a `summary.md` that a reviewer
can read in a pull request. Committing those folders is what makes a regression
visible in review.

## Still to do

- The rest of the breadth section 10.4 asks for: about twenty files, and one at
  the 2,600-cue end. Two full-length fixtures now exist; see **Scale** above.
- The blind pairwise preference test against the cheap tools of specification
  section 6.7, which decides whether the fast lane keeps its premium. It needs
  native speakers, not code.
- The effort sweep (`low`, `medium`, `high`), which the runner already supports
  through `--model` and a config override, but which has not been run because it
  needs the real API.
- A judged run of any kind. The rubric in `src/rubric.ts` is frozen and the
  runner drives it, but no real judging spend has been made, so every quality
  statement in this repository so far is a structural, cost or consistency
  measurement plus a reading of the files.
