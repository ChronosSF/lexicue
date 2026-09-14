import { expect, test } from "@playwright/test";
import {
  FREE_BALANCE_CENTS,
  addFiles,
  centsIn,
  chooseLanguage,
  expectBalanceCents,
  longFilmSrt,
  previewPriceCents,
  signInAndVerify,
} from "./support.js";

/**
 * Spec section 2.1 step 4: when the balance is short the button becomes "Top up
 * $5 and translate" and comes back to this screen after checkout. The product
 * never refuses an upload it could be paid for — it offers to be paid.
 *
 * The file is made here rather than taken from the corpus, because the corpus
 * is deliberately small and cheap; a balance is only short against a film.
 */

const FILE = "a-long-film.srt";
const TOP_UP_CENTS = 500;

test("offers a top-up instead of refusing, and the mock checkout credits the wallet", async ({
  page,
}) => {
  await signInAndVerify(page, "topup@example.com");

  await addFiles(page, [{ name: FILE, text: longFilmSrt() }]);
  const previewedCents = await previewPriceCents(page, FILE, "Fast");
  expect(previewedCents).toBeGreaterThan(FREE_BALANCE_CENTS);

  await chooseLanguage(page, "Polish");

  // A sentence with the arithmetic in it, not an error code.
  await expect(page.getByText(/short of this upload/)).toContainText(
    `which is $${((previewedCents - FREE_BALANCE_CENTS) / 100).toFixed(2)} short`,
  );

  const topUp = page.getByRole("button", { name: "Top up $5 and translate" });
  await expect(topUp).toBeEnabled();
  await topUp.click();

  // The demo's own checkout screen stands in for Stripe's hosted page.
  await expect(page.getByRole("heading", { name: "Add $5.00 to your balance" })).toBeVisible();
  await page.getByRole("button", { name: "Pay $5.00" }).click();

  // The balance follows the payment rather than the click: section 2.2 has the
  // page say so and keep polling instead of showing a stale number.
  await expect(page.getByRole("heading", { name: "$5.00 added to your balance" })).toBeVisible();
  await expectBalanceCents(page, FREE_BALANCE_CENTS + TOP_UP_CENTS);

  // "and returns to this screen after checkout": the same files, still priced
  // the same, and now affordable.
  await expect(page.getByRole("button", { name: /^Translate 1 file/ })).toBeEnabled();
  expect(centsIn(await page.getByRole("button", { name: /^Translate 1 file/ }).textContent())).toBe(
    previewedCents,
  );
});
