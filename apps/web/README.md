# apps/web — the web app

The single-page app of specification section 2. It runs two ways, and the
difference is whether anything is actually translated.

```sh
pnpm install

pnpm dev        # real: a local API translates with Claude Sonnet 5
pnpm dev:mock   # mock: the whole product in the browser, fake model, no network
```

`pnpm dev` is the default and needs a key. Copy `.env.example` to `.env` at the
repository root and paste the key after the equals sign; without it `pnpm dev`
stops and says so, naming the file, rather than quietly falling back to the
mock. It starts two processes — the local API on port 5174 and the app on 5173,
with `/api` proxied to the API — and stops both on Ctrl+C.

`pnpm dev:mock` needs nothing at all: no key, no server, no network after the
page loads.

## What to click

1. **Pick a sample file or drop your own.** The tray under the drop zone is the
   evaluation corpus from `evals/corpus`: two `.sub` dialects, a German source,
   a Spanish source, a hearing-impaired edition, a three-episode season and one
   file that fails. You can also drop your own files, a folder or a zip.
2. **Read the table.** Format, encoding, cue count, characters of dialogue,
   running time and the price on each lane, computed in the browser by the same
   packages the server re-computes them with before charging. Try a file that is
   not a subtitle file: it explains itself in its own row and can be removed on
   its own.
3. **Choose.** A language, a lane, and the options. The confirm button reads
   `Translate 1 file · $0.10`.
4. **Watch it run.** A row per file with a progress bar. In real mode the bar is
   the harness's own count of batches answered, so a 38-cue file takes about
   twenty seconds and a film would take minutes.
5. **Download.** Each file on its own, a zip when the last one lands, and a
   report per file behind the "Report" button — model, prompt version, effort,
   batches, wall time, and every reading-speed and line-length finding.

Things worth trying:

- **`fail.srt`** fails on purpose and is refunded automatically, in its own row,
  without touching the rest of the upload. Any file whose name contains "fail"
  behaves this way, in both modes; that is the only such rule.
- **All three Skerry Point episodes at once**, which share one season glossary.
  On the real backend they are translated in order, which is what carries a name
  or a running joke from episode one to episode three.
- **A file bigger than the balance** turns the confirm button into
  `Top up $5 and translate` and sends you to the checkout page.
- **Menu → Reset the demo** puts everything back, and in real mode also deletes
  every uploaded and translated file under `.local/dev-api`.

## Two backends behind one interface

`VITE_BACKEND=mock` chooses the mock; anything else is the real client.
`pnpm dev:mock` sets it through a Vite mode, because an inline environment
variable is not a command on Windows and a dependency to say so is not worth it.

|               | Mock (`pnpm dev:mock`)                               | Real (`pnpm dev`)                                            |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Where it runs | The browser                                          | `packages/dev-api` on port 5174, `/api` proxied to it        |
| Files         | Parsed and priced in the browser                     | Parsed and priced again on the server, which is what charges |
| Translation   | The harness with its deterministic fake model client | The harness with `claude-sonnet-5`                           |
| Storage       | `localStorage`                                       | `.local/dev-api`: one JSON file and the file bytes           |
| Progress      | A pure function of a shortened clock                 | The harness's own count of batches answered                  |
| Money         | Simulated                                            | Simulated                                                    |

The real backend is a thin HTTP adapter over `packages/core`, which is where
every rule actually lives; the mock is a second implementation of the same
contract in the browser. Both are implementations of section 7.3, not sets of
canned responses. Both charge the wallet with the transaction rules of
section 7.4, refuse uploads they cannot afford with the 402 and its shortfall,
refund failed files, enforce the limits of section 3.2, keep an append-only
ledger and delete files after 24 hours. The rules that decide what is refused
and what is charged live in `packages/shared` so that the two cannot drift
apart.

### Why the local API is a separate process

The choice was between a Vite dev-server middleware plugin and a separate Node
process that Vite proxies `/api` to. It is a separate process, for three
reasons:

1. **The workspace is consumed as TypeScript source through `tsx`**, which is
   how `pnpm harness` and `pnpm evals` already run. A plugin inside Vite would
   have had to reproduce that loading for the harness, `@lexicue/subtitles/encoding`
   and the Anthropic SDK, none of which belong in a browser bundle.
2. **A real HTTP hop is the point.** The app talks to the API through
   `RealBackend` — one `fetch` per route, the JWT in the `Authorization` header,
   every response parsed by the shared schema — so the client Phase 2 inherits
   has actually been exercised, rather than merely compiling.
3. **A translation is not interrupted when the front end hot-reloads.** A file
   takes tens of seconds to a few minutes; a Vite restart on every saved file
   would kill it.

The cost is one extra process, which `pnpm dev` starts and stops for you.

## What is real, and what is simulated

**Real, on `pnpm dev`:**

- The translation. Claude Sonnet 5, the real prompts, the real glossary passes,
  the real validation and retries, and the re-parse that proves the output is
  structurally identical to the input. It costs real money on the key in `.env`.
- Parsing, encoding detection, the cue count and the character count, done again
  on the server with the Node encoding detector, so the price charged is the
  price computed from the actual bytes.
- The price, the charge, the refunds and the ledger arithmetic.
- The limits of section 3.2 and every refusal: an unreadable file, a target that
  is already the source language, too many files, too many bytes, a balance that
  will not cover the upload.
- Progress. Per-file states and the bar advance as the harness actually gets
  through the file. There is no clock to simulate.
- Downloads, the zip, the byte-order mark, and the report.

**Simulated, and said so in the app:**

- **Money.** There is no card and no Stripe account, so choosing a top-up
  amount credits the balance through the local checkout screen. The header says
  "Local · real translation, simulated money" and the wallet screen says it in a
  sentence. The Stripe flow of specification section 6.6 _is_ written and
  tested against a fake Stripe (`packages/core/src/billing.ts`), and putting
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env` switches the top-up
  to Stripe's hosted page and turns the webhook route on — see the root README,
  which also says which parts of that have never been run.
- **Sign-in.** There is no Cognito and no password. `POST /api/dev/session`
  returns a token shaped like a JWT so the browser reads its claims exactly as
  it will read Cognito's, and verification is a button rather than an email.
- **Nothing is deployed.** Files live under `.local/`, not S3; state is a JSON
  file, not DynamoDB.

## What the demo cannot do

- **No economy lane in real mode.** It is refused before anything is charged,
  with a sentence saying why. It hands the work to the Message Batches API,
  which may take up to 24 hours to come back, and a development server that
  restarts whenever a file changes is the wrong place to hold that. The lane
  itself does work against the real API — it was run from the command line on
  12 September 2026 and came back in eight minutes, with the numbers in the
  root `README.md` — but nothing in the app has ever driven it.
- **No per-file failure isolation on the real backend.** `translateUpload`
  drives a whole upload and raises rather than isolating one bad file, so a
  failure fails the files of that upload that had not finished and refunds each
  of them separately. The ledger stays exact; the blast radius is a batch rather
  than a file. Section 2.3's per-file isolation needs the queue and the
  one-message-per-file split of section 7.5, which is Phase 2's worker.
- **Files are translated one at a time, not three at once.** Section 3.2 allows
  three on the fast lane, but the harness translates a multi-file upload in
  order on purpose: that ordering is what lets a character introduced in episode
  two reach episode three. The notice above the file rows says so.
- **No Cognito, no email, no deployed AWS.** Stripe is the exception and only
  half an exception: the code and its tests exist, the keys do not, and nothing
  has ever been exercised against Stripe itself.
- **No economy-lane overdue path.** A Message Batch that ran past 24 hours would
  be refunded and re-run on the fast lane (section 2.3); nothing here simulates
  a day of waiting.
- **In mock mode, no real translation at all.** The fake model wraps English
  dialogue in guillemets («like this») and leaves every tag, code, index and
  timecode alone. That proves the structural guarantee and nothing else, and for
  a target in a non-Latin script the harness is right to report every cue as
  untranslated, because English is not Bulgarian. The batch screen says so.
- **Files dropped but not yet confirmed live in memory only.** Reloading before
  you press confirm loses them; everything the backend knows about survives.

## Where the specification is ambiguous

The rule was to take the simplest reading that keeps the specification's rules,
and to write the reading down. These are all of them.

1. **Transactions have no route.** Section 2.2 requires a list of every
   transaction; section 7.3 has no route for one. They ride on `GET /api/me`,
   which already returns the balance and the recent batches.
2. **Sign-in is not part of the API.** Cognito is not `/api/*`, so sign-in,
   verification and sign-out are methods on the backend adapter rather than
   routes. The real adapter refuses them with a sentence saying Phase 2 owns
   them, unless it is handed the development stand-in described above.
3. **A refund restores the free portion.** Section 2.3 says a failed file is
   refunded; it does not say what happens to the free credit that paid for it.
   Both backends put the free portion back, so a trial user who meets a failure
   has lost nothing, which is what section 6.5 promises.
4. **The same-language refusal happens before the charge.** Section 3.3 refuses
   a job whose target is the detected source language, but section 4.4 detects
   that language in the glossary pass, which runs after the charge. Both
   backends guess with a stopword count first, and refuse on the base language,
   so a Spanish file cannot be translated into either Spanish variant.
5. **The browser prices with the bundled package.** Section 9.6 has the SPA read
   its prices from `GET /api/pricing`; section 6.1 has the price computed
   identically in the browser and on the server. The table uses the price
   function from `packages/pricing`, and `/api/pricing` supplies the top-up
   amounts, the delivery wording and the worked examples. Since the server
   re-prices every file before charging, the price shown is always the price
   confirmed by the side that takes the money.
6. **Encoding detection differs in the browser.** `packages/subtitles/encoding`
   uses chardet and iconv-lite, which are Node libraries. The browser entry
   point scores the legacy code pages with `TextDecoder` alone; its test asserts
   it agrees with the Node detector on the same bytes. The real backend re-reads
   every file with the Node detector, so the server's answer is the one that
   counts.
7. **Polling intervals.** Section 7.3 asks for two seconds on the fast lane and
   thirty on the economy lane. The interval comes from the response
   (`pollAfterMs`); the mock shortens it to match its shortened clock.
8. **Line handling and lyrics** are options in section 3.4 with no separate UI
   treatment described. They sit under "More options" with the byte-order mark.
9. **Zip naming.** Two finished files with the same name would overwrite each
   other inside the zip, which a folder drop makes possible; the second becomes
   `episode (2).de.srt`.
10. **A presigned POST has no local equivalent, so it has a small one.**
    `POST /api/uploads` returns a URL on the local API that accepts the same
    `multipart/form-data` body S3's browser upload takes, and a finished file is
    a link carrying an expiry and a signature, which is what a presigned GET is.
    None of that client code changes when S3 arrives.
11. **"The same name renderings in every episode" cannot mean every episode.**
    Section 10.4 asks the cross-episode check for "same name renderings, same
    form of address in every episode". Read literally that is a false positive
    waiting to happen, and it happened: the check reported a rendering absent
    from one episode as drift when that episode's source never names the
    character at all — Ivo is never named in episode two of the season fixture,
    Petar never in episode one. The reading taken is that the subject of the
    check is the episodes whose _source_ contains the term, and that a finding
    needs a disagreement among those: some render it the fixed way and some do
    not. An episode that never says a name cannot say it inconsistently.

## Where the specification is wrong

Three things in the specification are not ambiguous, they are incorrect. Two of
them cost money before anyone noticed.

**Section 10.4's eval budget does not reconcile with the rest of the
specification.** It says a full run is "roughly 20 files at Sonnet 5 prices plus
judging, about $25 to $35". The same section defines the corpus as about 20
files of 300 to 2,600 cues and the targets as eight languages, and section 5.3
prices a 650-cue drama episode at $0.39 and a 1,400-cue film at $0.75. Twenty
files averaging a thousand cues, into eight languages, is about $88 of
translation before a judge call is made. Either the $25 to $35 is the cost of
one target language rather than all eight, or it is out by a factor of three.
Nothing depends on the answer yet, because the corpus is smaller than the
section asks for and the measured projection for what does exist is $13 to $18
(root `README.md`), but the number should not be quoted as a budget until the
founder says which it is.

**Section 4.5's `custom_id` of `{jobId}:{batchIndex}` is rejected by the
Message Batches API.** A `custom_id` must match `^[a-zA-Z0-9_-]{1,64}$`, and a
colon is not in that set, so the API answers the whole submission with a 400
naming the first offending request. This is expensive in exactly the way that
stings: on the economy lane every file's glossary pass has already run and been
paid for by the time the batch is submitted, so the refusal costs real money and
produces nothing. Measured on 12 September 2026, on the first economy-lane
submission this repository ever made. The separator is now an underscore, and
`submitEconomyBatch` checks every id against the API's own pattern — and for
duplicates — before the request leaves, so the next id that breaks the rule
fails locally and for free.

**Section 4.4's glossary pass cannot warm the cache its batches read.** The
section says the first request for a file "warms the cache that the batches
read", and section 5.4 prices a film on one cache write and twelve cache reads.
A request's structured-output schema is part of its cache key — it renders ahead
of the system prompt, the way a tool list does — and the glossary pass's schema
is not the batch schema, so the entry it writes can never be read. Measured
against Sonnet 5 on 11 September 2026, with the numbers in the root README. The
harness now drops that unreadable write and lets the first batch warm the
prefix before the rest fan out; the section's own cost model holds again once it
does, but the section's explanation of why does not.

## Layout

```
src/app          the backend context, the hash router, the query hooks, the upload draft
src/backend      the adapter interface, the mock backend, the real fetch client, the dev extras
src/features     auth, upload, options, batch, wallet, history
src/ui           the header, the menu, the shared formatting
src/styles       tokens and the element defaults
public/samples   copies of the evaluation corpus, plus fail.srt
```

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test                 # the packages and the app, in two Vitest projects
pnpm --filter web build
```

The app's own tests are the mock backend's wallet and state machine, the file
intake, the wording of the confirm button, the batch screen's deletion notice,
one test that clicks the whole flow from a sample file to a downloaded
translation, and one that builds the app for production and asserts the bundle
carries no development-only route and no API key.

## The end-to-end suite

The same flows through a real browser, against this mock: specification section
10.3's smoke test as code rather than as somebody's clicks.

```sh
pnpm --filter web exec playwright install chromium   # once per machine
pnpm --filter web e2e                                # 9 tests, about 20 seconds
pnpm --filter web e2e --headed                       # to watch it happen
pnpm --filter web e2e --ui                           # to pick one apart
```

The specs are `e2e/*.e2e.ts` — a suffix of their own, so neither Vitest project
picks them up — and they are typed by `e2e/tsconfig.json`, which `pnpm typecheck`
checks alongside the app.

`playwright.config.ts` builds this app with `vite build --mode mock` and serves
the result with `vite preview` on **port 4183**, its own and nobody else's:
`strictPort` and `reuseExistingServer: false` mean the suite serves the build it
just made, and a `pnpm dev` on 5173 or a local API on 5174 is neither borrowed
nor disturbed. A production build rather than the dev server, because the mock
is chosen at build time, so testing the bundle that would ship costs one extra
second.

Each test signs in as its own address and gets its own browser context, so its
own `localStorage` and its own demo state; they run in parallel and share only a
static file server. They address the page by role and accessible name — no CSS
class appears in the suite — and they assert on the bytes the browser actually
saved, parsed with `@lexicue/subtitles`: same cue count, every timing line
identical to the source, the byte-order mark where the options say it should be,
and the wallet down by exactly the price the table previewed.

What they cover, in order of the "what to click" list above: the sample tray and
the preview table, including a dropped zip unpacked in the browser and a file
that is not a subtitle file explaining itself in its own row and being removed
without discarding the rest; the
language and lane choices and the confirm button's arithmetic; `fail.srt`'s
automatic refund and the ledger entry behind it; a balance too short, which
offers a top-up and credits it through the mock checkout; the economy lane's
notice and its file coming back intact; all three Skerry Point episodes at once,
their shared season glossary, and the "Download all" zip, unpacked and parsed
file by file; the same-language refusal of section 3.3; and the history and
"Reset the demo".
