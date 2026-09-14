import { expect, test } from "@playwright/test";
import {
  FREE_BALANCE_CENTS,
  allCentsIn,
  chooseLanguage,
  expectBalanceCents,
  openMenu,
  previewPriceCents,
  sample,
  signInAndVerify,
} from "./support.js";

/**
 * The failure behaviour of spec section 2.3: a file that fails is refunded
 * automatically and says so in its own row. `fail.srt` is the demo's file for
 * exactly this — any name containing "fail" is failed on purpose, in both
 * backends, and that is the only such rule.
 */

test("refunds a file that fails, says so in its row and leaves the balance where it started", async ({
  page,
}) => {
  await signInAndVerify(page, "refund@example.com");

  await sample(page, "fail.srt").click();
  const previewedCents = await previewPriceCents(page, "fail.srt", "Fast");

  await chooseLanguage(page, "French");
  await page.getByRole("button", { name: /^Translate 1 file/ }).click();

  // Partial results are never sold: the file either comes back intact or it
  // costs nothing.
  await expect(
    page.getByRole("heading", { name: "Nothing could be translated, and everything was refunded" }),
  ).toBeVisible({ timeout: 30_000 });

  // The row says it, in a sentence rather than an error code.
  const row = page.getByRole("listitem").filter({ hasText: "fail.srt" });
  await expect(row).toContainText("refunded to your balance");
  await expect(row).toContainText("Nothing else in the upload was affected");
  await expect(row).toContainText("Refunded");
  // There is nothing to download, so no download is offered.
  await expect(row.getByRole("link", { name: "Download" })).toHaveCount(0);

  // "Charged $0.00 after $0.10 refunded for 1 file that failed."
  const charged = page.getByText(/^Charged \$/);
  await expect(charged).toContainText("refunded for 1 file that failed");
  expect(allCentsIn(await charged.textContent())).toEqual([0, previewedCents]);

  // The balance is where it started, and the header says so on this screen,
  // without a reload: the refund lands while the batch screen is only polling
  // the batch, and the poll that shows it is what asks the wallet again.
  await expectBalanceCents(page, FREE_BALANCE_CENTS);

  // And the ledger of section 2.2 shows both halves of it.
  await openMenu(page, "Wallet");
  await expect(page.getByText("Refund for fail.srt")).toBeVisible();
  await expect(page.getByRole("heading", { name: "$2.50" })).toBeVisible();
});
