import { expect, test } from "@playwright/test";
import {
  FREE_BALANCE_CENTS,
  balance,
  centsIn,
  chooseLane,
  chooseLanguage,
  cueCount,
  download,
  expectBalanceCents,
  fileRow,
  previewPriceCents,
  sample,
  sampleText,
  signInAndVerify,
  timingLines,
} from "./support.js";

/**
 * The smoke test of spec section 10.3, which that section runs against staging
 * after every deploy: sign in, upload a fixture on the fast lane, translate,
 * download, verify the file and the charge. Here the backend is the mock, so it
 * costs nothing and needs no key, and everything it checks is real code: the
 * parser, the price function, the wallet arithmetic and the harness.
 */

const FILE = "the-lamp-room.srt";

test("translates a sample file and charges exactly the price the table previewed", async ({
  page,
}) => {
  await signInAndVerify(page, "smoke@example.com");

  // Verification is what grants the free balance of spec section 6.5.
  const startingCents = FREE_BALANCE_CENTS;
  await expect(balance(page)).toContainText("free credit");

  await sample(page, "The Lamp Room").click();

  // Step 2 of section 2.1: the table says what the app understood, before
  // anything is charged.
  const row = fileRow(page, FILE);
  await expect(row).toContainText("SubRip");
  await expect(row).toContainText("38");
  const previewedCents = await previewPriceCents(page, FILE, "Fast");

  await chooseLanguage(page, "German");
  await chooseLane(page, "Fast");

  // Step 4: the button carries the count and the exact price, and it is the
  // same price the table showed.
  const confirm = page.getByRole("button", { name: /^Translate 1 file/ });
  expect(centsIn(await confirm.textContent())).toBe(previewedCents);
  await confirm.click();

  // Step 5: a row per file, and then the file is ready. The mock's clock runs
  // in seconds rather than the minutes a real film takes.
  await expect(page.getByRole("heading", { name: "Your file is ready" })).toBeVisible({
    timeout: 30_000,
  });

  // Step 6: the download, named for the target language.
  const saved = await download(page, page.getByRole("link", { name: "Download", exact: true }));
  expect(saved.fileName).toBe("the-lamp-room.de.srt");

  // UTF-8 with a byte-order mark is the default output of spec section 3.1.
  expect([...saved.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

  // The structural guarantee of section 4.1, checked on the bytes the browser
  // actually saved: same cues, and every timing line identical to the source.
  const source = sampleText(FILE);
  const translated = saved.bytes.toString("utf8");
  expect(cueCount(translated, saved.fileName)).toBe(cueCount(source, FILE));
  expect(timingLines(translated, saved.fileName)).toEqual(timingLines(source, FILE));
  // And it is a translation, not a copy: the demo's fake model wraps dialogue
  // in guillemets and touches nothing else.
  expect(translated).toContain("«");
  expect(translated).not.toEqual(source);

  // The charge of section 6.1: the wallet moved by the previewed price, to the
  // cent, and by nothing else.
  await expectBalanceCents(page, startingCents - previewedCents);

  // The report of section 3.5 is one click away and knows what happened.
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.getByText("38 of 38 cues")).toBeVisible();
  await expect(page.getByText("claude-sonnet-5")).toBeVisible();
});
