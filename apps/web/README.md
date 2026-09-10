# apps/web — the web app

The single-page app of specification section 2, built to be run and clicked
through today. It ships with a mock backend that lives entirely in the browser:
no AWS, no Stripe, no Cognito, no API key, no network at all after the page
loads.

```sh
pnpm install
pnpm dev            # http://localhost:5173
```

That is the whole setup. `pnpm dev` starts the app in mock mode; the demo lands
signed in as `demo@example.com` with $12.50 in the wallet, $2.30 of it free
credit, and one finished upload already in the history.

## What to click

1. **Pick a sample file.** The tray under the drop zone is the evaluation corpus
   from `evals/corpus`: two `.sub` dialects, a German source, a Spanish source,
   a hearing-impaired edition, a three-episode season and one file that fails.
   You can also drop your own files, a folder or a zip.
2. **Read the table.** Format, encoding, cue count, characters of dialogue,
   running time and the price on each lane, all computed in the browser by the
   same packages the server will use. Try a file that is not a subtitle file:
   it explains itself in its own row and can be removed on its own.
3. **Choose.** A language (the list is searchable, with the regional variants
   side by side), a lane, and the options. The confirm button reads
   `Translate 1 file · $0.10`.
4. **Watch it run.** A row per file with a progress bar. Three files translate
   at once on the fast lane and the rest queue, which the notice above the rows
   says in a sentence. The economy lane says the upload was submitted and that
   you can leave.
5. **Download.** Each file on its own, a zip when the last one lands, and a
   report per file behind the "Report" button.

Things worth trying:

- **`fail.srt`** fails on purpose and is refunded automatically, in its own row,
  without touching the rest of the upload. Any file whose name contains "fail"
  behaves this way; that is the only such rule in the demo.
- **All three Skerry Point episodes at once**, on the economy lane, produce the
  shared season glossary under the file rows.
- **A file bigger than the balance** turns the confirm button into
  `Top up $5 and translate` and sends you to the demo's own checkout page.
- **Reload at any point.** The balance, the history and finished files survive;
  a batch that was running carries on from where the clock says it should be.
- **Menu → Reset the demo** puts everything back to the starting state.

## Two backends behind one interface

`VITE_BACKEND` chooses; anything but `real` is the mock.

|               | Mock (default)                                                   | Real                                    |
| ------------- | ---------------------------------------------------------------- | --------------------------------------- |
| Where it runs | The browser                                                      | `/api/*` with a Cognito JWT             |
| Files         | Parsed with `packages/subtitles`, priced with `packages/pricing` | The same, server-side, on upload        |
| Translation   | The harness with its deterministic fake model client             | The harness with Claude Sonnet 5        |
| Storage       | `localStorage`, under the product's own retention rules          | DynamoDB and S3                         |
| Status        | This task's deliverable                                          | Compiles; Phase 2 stands the backend up |

The mock is an implementation of the section 7.3 contract, not a set of canned
responses. It charges the wallet with the transaction rules of section 7.4,
refuses uploads it cannot afford with the 402 and its shortfall, refunds failed
files, enforces the limits of section 3.2, keeps an append-only ledger, deletes
files after 24 hours and history after 30 days, and translates through the real
harness, so a downloaded file is byte-identical to its source apart from the
dialogue. Its seed data is produced by driving its own public API: it signs in,
verifies to earn the $2.50, tops up $10 three days ago and translates two
episodes two hours ago.

**The fake model is not a translator.** It wraps English dialogue in guillemets
(«like this») and leaves every tag, code, index and timecode alone. That proves
the structural guarantee and nothing else, and for a target in a non-Latin
script the harness is right to report every cue as untranslated, because English
is not Bulgarian. The batch screen says so where it happens.

## What the demo cannot do

- No real translation, no model call, no API key, and no way to make one.
- No Stripe. The checkout page is part of this app; confirming it credits the
  balance after a short delay, in place of the webhook.
- No Cognito, no password and no email. Verification is a button.
- No email on completion, and no economy-lane overdue path: a Message Batch that
  runs past 24 hours would be refunded and re-run on the fast lane in the real
  system (section 2.3), and the demo has nothing to simulate a day of waiting.
- Time is simulated. A file takes a few seconds instead of a few minutes, and an
  economy batch comes back in about twelve seconds instead of an hour. Progress
  is a pure function of the clock, which is why a reload does not disturb it.
- Files dropped but not yet confirmed live in memory only. Reloading before you
  press the confirm button loses them; everything the backend knows about
  survives.

## Where the specification is ambiguous

The rule was to take the simplest reading that keeps the specification's rules,
and to write the reading down. These are all of them.

1. **Transactions have no route.** Section 2.2 requires a list of every
   transaction; section 7.3 has no route for one. They ride on `GET /api/me`,
   which already returns the balance and the recent batches.
2. **Sign-in is not part of the API.** Cognito is not `/api/*`, so sign-in,
   verification and sign-out are methods on the backend adapter rather than
   routes. The real adapter reads the session out of the token and refuses the
   sign-in methods with a sentence saying Phase 2 owns them.
3. **A refund restores the free portion.** Section 2.3 says a failed file is
   refunded; it does not say what happens to the free credit that paid for it.
   The demo puts the free portion back, so a trial user who meets a failure has
   lost nothing, which is what section 6.5 promises.
4. **The same-language refusal happens before the charge.** Section 3.3 refuses
   a job whose target is the detected source language, but section 4.4 detects
   that language in the glossary pass, which runs after the charge. The mock
   guesses with a stopword count first, and refuses on the base language, so a
   Spanish file cannot be translated into either Spanish variant.
5. **The browser prices with the bundled package.** Section 9.6 has the SPA read
   its prices from `GET /api/pricing`; section 6.1 has the price computed
   identically in the browser and on the server. The table uses the price
   function from `packages/pricing`, and `/api/pricing` supplies the top-up
   amounts, the delivery wording and the worked examples. Since the server
   re-prices every file before charging, the price shown is always the price
   confirmed by the side that takes the money.
6. **Encoding detection differs in the browser.** `packages/subtitles/encoding`
   uses chardet and iconv-lite, which are Node libraries. The browser entry
   point added for this app scores the legacy code pages with `TextDecoder`
   alone; its test asserts it agrees with the Node detector on the same bytes.
   Two Latin code pages that both produce plausible letters cannot be told apart
   without a language model, and ties go to Windows-1252.
7. **Polling intervals.** Section 7.3 asks for two seconds on the fast lane and
   thirty on the economy lane. The interval comes from the response
   (`pollAfterMs`), and the mock shortens it to match its shortened clock.
8. **Line handling and lyrics** are options in section 3.4 with no separate UI
   treatment described. They sit under "More options" with the byte-order mark,
   and travel to the harness like the rest.
9. **Zip naming.** Two finished files with the same name would overwrite each
   other inside the zip, which a folder drop makes possible; the second becomes
   `episode (2).de.srt`.

## Layout

```
src/app          the backend context, the hash router, the query hooks, the upload draft
src/backend      the adapter interface, the mock backend, the real fetch client
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
intake, the wording of the confirm button, and one test that clicks the whole
flow from a sample file to a downloaded translation.
