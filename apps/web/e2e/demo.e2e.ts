import { expect, test } from "@playwright/test";
import {
  FREE_BALANCE_CENTS,
  balance,
  balanceCents,
  expectBalanceCents,
  openMenu,
  signInAndVerify,
} from "./support.js";

/**
 * The history of spec section 2.2 and the demo's own reset. The seeded state is
 * not hand-written data: the demo signs itself in, tops itself up and
 * translates two episodes through the same methods a click goes through, so the
 * history row below is real output of the real harness — which is also why
 * putting it back has to work.
 */

test("lists the seeded upload in the history, opens it, and puts the demo back", async ({
  page,
}) => {
  await page.goto("/");
  await expect(balance(page)).toBeVisible();
  const demoCents = await balanceCents(page);

  await openMenu(page, "History");
  const row = page.getByRole("button", { name: /skerry-point-s01e01\.srt/ });
  await expect(row).toContainText("German");
  await expect(row).toContainText("economy");
  await expect(row).toContainText("Delivered");

  await row.click();
  await expect(page.getByRole("heading", { name: "Season glossary" })).toBeVisible();

  // Somebody else's account: their own empty history, their own free balance.
  await signInAndVerify(page, "stranger@example.com");
  await openMenu(page, "History");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await expectBalanceCents(page, FREE_BALANCE_CENTS);

  // "Menu → Reset the demo puts everything back."
  await openMenu(page, "Reset the demo");
  await expectBalanceCents(page, demoCents);
  await openMenu(page, "History");
  await expect(page.getByRole("button", { name: /skerry-point-s01e01\.srt/ })).toBeVisible();
});
