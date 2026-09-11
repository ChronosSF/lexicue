# Evaluation

The instrument for every prompt, effort, batch-size and lane decision
(specification section 10.4). It exists before the web app does, and it has a
commercial job as well as a technical one: proving the quality difference that
justifies the price premium over the cheap tools in section 6.7.

## The corpus

`evals/corpus` holds eleven files, all written for this project. Nothing in it
is copied from a real film, a real subtitle release, or anyone else's work, so
the whole corpus is safe to redistribute. `manifest.json` describes each file
and says what it exists to cover.

| Area                     | Files                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Comedy                   | `comedy/the-lamp-room.srt`                                                                                                                                                     |
| Drama                    | `drama/the-last-tender.srt`                                                                                                                                                    |
| Documentary              | `documentary/the-keepers.srt`                                                                                                                                                  |
| Hearing-impaired edition | `hearing-impaired/the-lamp-room.hi.srt` — bracketed sounds, speaker labels, music notes and lyrics                                                                             |
| Non-English sources      | `german/der-leuchtturm.srt`, `spanish/el-faro.srt`                                                                                                                             |
| The other two formats    | `formats/the-lamp-room.microdvd.sub`, `formats/the-lamp-room.subviewer.sub` — the same dialogue as the comedy, so all three must price identically                             |
| A three-episode season   | `season/skerry-point-s01e0{1,2,3}.srt` — Marta and Ivo throughout, Petar introduced late in episode two, and three running jokes (the gulls, the stairs, the Light's opinions) |

**Scale.** The specification asks for about twenty files of 300 to 2,600 cues.
These eleven files are 23 to 39 cues each. They cover every _shape_ the
specification lists, and the runner does not care how long a file is, but they
do not yet exercise a feature-length file's batching, cost or latency. Writing
the full-length fixtures is the first thing to do before the eval is used to
make a pricing or effort decision.

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

A full run is the whole corpus into eight languages plus judging. On the
current, reduced corpus that is a few dollars; on the full-length corpus the
specification's estimate is $25 to $35 per run. `pnpm evals run --help` lists
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

- The full-length fixtures described under **Scale** above.
- The blind pairwise preference test against the cheap tools of specification
  section 6.7, which decides whether the fast lane keeps its premium. It needs
  native speakers, not code.
- The effort sweep (`low`, `medium`, `high`), which the runner already supports
  through `--model` and a config override, but which has not been run because it
  needs the real API.
- A judged Haiku 4.5 comparison. The unjudged one has been run — through the
  command-line tool rather than this runner, over four files into German and
  Bulgarian; the root `README.md` has its cost, structural and cross-episode
  consistency results. Nobody has yet scored either model on the rubric in
  `src/rubric.ts`, which is what would turn that into a quality verdict.
