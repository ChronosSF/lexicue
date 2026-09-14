import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { parseSubtitleText } from "@lexicue/subtitles";

/**
 * What every spec in this folder shares: the corpus on disk, the few readings
 * of the interface that are worth naming once (the balance, a price in the
 * preview table, the bytes behind a download link), and the sign-in of spec
 * section 2.1 step 1.
 *
 * Everything here addresses the page by role and accessible name. Not one CSS
 * class appears in this suite: a class is a styling decision that may change
 * next week, and a role and a label are what the user and the screen reader
 * actually have.
 */

/** `apps/web/public/samples`, which is the evaluation corpus the demo serves. */
export const SAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/samples");

export function sampleText(path: string): string {
  return readFileSync(resolve(SAMPLES_DIR, path), "utf8");
}

/**
 * The timing lines of a subtitle file, exactly as they appear in it. The parser
 * copies them verbatim and never re-serialises them from the parsed
 * milliseconds (`Cue.rawTimingLine`), so comparing these two lists is the
 * structural guarantee of spec section 4.1 checked on the real download.
 */
export function timingLines(text: string, fileName: string): string[] {
  return parseSubtitleText(text, { fileName }).cues.map((cue) => cue.rawTimingLine);
}

export function cueCount(text: string, fileName: string): number {
  return parseSubtitleText(text, { fileName }).cues.length;
}

/** "$12.50" anywhere in a string, as 1250. */
export function centsIn(text: string | null): number {
  const match = /\$(\d[\d,]*)\.(\d{2})/.exec(text ?? "");
  if (match === null) throw new Error(`No amount of money in ${JSON.stringify(text)}`);
  return Number((match[1] ?? "0").replaceAll(",", "")) * 100 + Number(match[2] ?? "0");
}

/** Every amount of money in a string, in order, as cents. */
export function allCentsIn(text: string | null): number[] {
  return [...(text ?? "").matchAll(/\$\d[\d,]*\.\d{2}/g)].map((match) => centsIn(match[0]));
}

function escapeForRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** What verifying an email address credits (spec sections 2.1 and 6.5). */
export const FREE_BALANCE_CENTS = 250;

/** The header's balance pill, which is a button once there is a wallet to open. */
export function balance(page: Page): Locator {
  return page.getByRole("button", { name: /^Balance/ });
}

export async function balanceCents(page: Page): Promise<number> {
  return centsIn(await balance(page).textContent());
}

/**
 * Waits for the header to settle on an amount.
 *
 * The balance is a query with a five-second staleness, so the pill can hold the
 * previous account's number for a moment after a sign-in and the previous
 * batch's number until the wallet is invalidated. Polling is what the user does
 * too: they look again.
 */
export async function expectBalanceCents(page: Page, cents: number): Promise<void> {
  await expect.poll(() => balanceCents(page), { timeout: 15_000 }).toBe(cents);
}

/**
 * One sample in the tray, by its title. The regular expression is anchored and
 * followed by whitespace because four samples begin with "The Lamp Room", and
 * an ambiguous locator is a test that fails on the day somebody adds a file.
 */
export function sample(page: Page, title: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${escapeForRegExp(title)}\\s`) });
}

export function fileRow(page: Page, fileName: string): Locator {
  return page.getByRole("row", { name: new RegExp(escapeForRegExp(fileName)) });
}

/**
 * The price the preview table shows for one file on one lane, found by reading
 * the column headings rather than by counting columns, so the suite survives a
 * new column.
 */
export async function previewPriceCents(
  page: Page,
  fileName: string,
  lane: "Fast" | "Economy",
): Promise<number> {
  // Wait for the row before reading the headings. `allTextContents` is a
  // one-shot read with no auto-waiting of its own, so a table that has not
  // rendered yet comes back as an empty list and reports a missing column
  // rather than a missing table — which is a race, and on a parsing-heavy file
  // it is a race that loses.
  await expect(fileRow(page, fileName)).toBeVisible();
  // The headings are text content rather than rendered text on purpose: the
  // table renders them uppercase, and `innerText` would hand back "FAST".
  const headings = await page.getByRole("columnheader").allTextContents();
  const column = headings.findIndex((heading) => heading.trim() === lane);
  expect(column, `the table has no ${lane} column`).toBeGreaterThan(-1);
  return centsIn(await fileRow(page, fileName).getByRole("cell").nth(column).textContent());
}

export async function chooseLanguage(page: Page, name: string): Promise<void> {
  await page.getByRole("combobox", { name: "Target language" }).fill(name);
  await page.getByRole("option", { name }).click();
}

/**
 * Picks a delivery lane.
 *
 * The radio itself is visually hidden and the whole card is the control, with
 * the sticky confirm bar over the bottom of the page, so a click by coordinate
 * lands on whatever happens to be on top. The keyboard is how a radio group is
 * meant to be driven and it has no such ambiguity: focus the radio, press
 * space, and check that the group moved.
 */
export async function chooseLane(page: Page, lane: "Fast" | "Economy"): Promise<void> {
  const radio = page.getByRole("radio", { name: new RegExp(`^${lane}\\s`) });
  await radio.focus();
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
}

/**
 * The account menu the wallet and history live behind. The name is anchored
 * because every item carries a hint under it, and "Reset the demo" explains
 * itself with the word "history" in it.
 */
export async function openMenu(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${escapeForRegExp(item)}\\b`) }).click();
}

/**
 * Spec section 2.1 step 1: sign in with an email address and follow the
 * verification link, which is what credits the $2.50 free balance.
 *
 * The demo seeds itself signed in as its own user with a history behind it, so
 * this signs out first. Signing in as somebody else starts that account from
 * nothing, which is exactly what the smoke test wants: a known balance, no
 * history, and the grant arriving where the test can watch it.
 */
export async function signInAndVerify(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await openMenu(page, "Sign out");

  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.getByRole("button", { name: "I have verified my email" }).click();

  // The account is new, so the balance is the grant and nothing else. Waiting
  // for that exact number is what makes every later assertion about money a
  // statement about this test's own upload.
  await expect(balance(page)).toBeVisible();
  await expectBalanceCents(page, FREE_BALANCE_CENTS);
}

/**
 * Hands files to the page through the picker the drop zone opens. Nothing is
 * written to disk: the bytes go straight to the chooser, which is what a real
 * pick hands the page.
 */
async function pick(
  page: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
): Promise<void> {
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /^(Choose files|Add more files)$/ }).click();
  const chooser = await picker;
  await chooser.setFiles(files);
}

export async function addFiles(page: Page, files: { name: string; text: string }[]): Promise<void> {
  await pick(
    page,
    files.map((file) => ({
      name: file.name,
      mimeType: "text/plain",
      buffer: Buffer.from(file.text, "utf8"),
    })),
  );
}

/** Drops a zip, built here, the way spec section 3.1 says one may be dropped. */
export async function addZip(
  page: Page,
  name: string,
  entries: Record<string, string>,
): Promise<void> {
  const zipped = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([entry, text]) => [entry, new TextEncoder().encode(text)]),
    ),
    { level: 6 },
  );
  await pick(page, [{ name, mimeType: "application/zip", buffer: Buffer.from(zipped) }]);
}

/**
 * A file with more dialogue in it than a new account's free balance covers, for
 * the top-up path of spec section 2.1 step 4. Seven hundred cues of two lines
 * is about 100,000 characters, which is $3 on the fast lane: over the $2.50
 * grant, and under the $7.50 a single top-up leaves behind.
 */
/**
 * A film with more dialogue than the $2.50 free balance covers, and not so much
 * more that the smallest top-up cannot cover it. At 144 characters per cue,
 * 1,500 cues is $3.36 on the fast lane under the rates adopted on 14 September
 * 2026 — 1 cent per 1,000 characters plus 8 cents per 100 cues — so the
 * shortfall is 86 cents and $5 is the top-up offered.
 */
export function longFilmSrt(cues = 1_500): string {
  const line = "Every line of this file carries a great many billable characters indeed.";
  const stamp = (ms: number): string => {
    const pad = (value: number, size = 2): string => value.toString().padStart(size, "0");
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(
      Math.floor((ms % 60_000) / 1000),
    )},${pad(ms % 1000, 3)}`;
  };
  const blocks = Array.from({ length: cues }, (_unused, index) => {
    const start = index * 3_000;
    return [(index + 1).toString(), `${stamp(start)} --> ${stamp(start + 2_500)}`, line, line].join(
      "\n",
    );
  });
  return `${blocks.join("\n\n")}\n`;
}

/** Clicks something that downloads a file and returns what the browser saved. */
export async function download(
  page: Page,
  trigger: Locator,
): Promise<{ fileName: string; bytes: Buffer }> {
  const [saved] = await Promise.all([page.waitForEvent("download"), trigger.click()]);
  const path = await saved.path();
  return { fileName: saved.suggestedFilename(), bytes: readFileSync(path) };
}
