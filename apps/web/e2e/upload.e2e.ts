import { expect, test } from "@playwright/test";
import {
  FREE_BALANCE_CENTS,
  addFiles,
  addZip,
  chooseLanguage,
  expectBalanceCents,
  fileRow,
  openMenu,
  sample,
  sampleText,
  signInAndVerify,
} from "./support.js";

/**
 * The two things the preview table of spec section 2.1 promises beyond the
 * price: a file it cannot use explains itself in its own row and can be taken
 * out without discarding the rest, and a refusal that only the backend can make
 * arrives as a sentence rather than as a failed job.
 */

test("explains a file it cannot use and removes it without discarding the rest", async ({
  page,
}) => {
  await signInAndVerify(page, "intake@example.com");

  await sample(page, "The Keepers").click();
  await addFiles(page, [
    { name: "notes.srt", text: "These are my notes about the film, not subtitles.\n" },
  ]);

  await expect(page.getByText("1 file cannot be translated")).toBeVisible();
  await expect(fileRow(page, "notes.srt")).toContainText("format was not recognised");

  // The confirm button counts only what it can actually translate.
  await chooseLanguage(page, "German");
  await expect(page.getByRole("button", { name: /^Translate 1 file/ })).toBeVisible();

  // And the bad file goes on its own.
  await fileRow(page, "notes.srt").getByRole("button", { name: "Remove notes.srt" }).click();
  await expect(fileRow(page, "notes.srt")).toHaveCount(0);
  await expect(fileRow(page, "the-keepers.srt")).toBeVisible();
  await expect(page.getByText("cannot be translated")).toHaveCount(0);
});

test("unpacks a zip in the browser and notes what it left out", async ({ page }) => {
  await signInAndVerify(page, "zip@example.com");

  await addZip(page, "season.zip", {
    "the-lamp-room.srt": sampleText("the-lamp-room.srt"),
    "cover.txt": "Artwork credits, which are not subtitles.\n",
  });

  await expect(fileRow(page, "the-lamp-room.srt")).toContainText("SubRip");
  await expect(page.getByText(/Ignored cover\.txt: only SubRip/)).toBeVisible();
});

test("refuses a target language the file is already in, before anything is charged", async ({
  page,
}) => {
  await signInAndVerify(page, "same-language@example.com");

  // A German source, which is what this sample is in the tray for.
  await sample(page, "Der Leuchtturm").click();
  await chooseLanguage(page, "German");
  await page.getByRole("button", { name: /^Translate 1 file/ }).click();

  await expect(page.getByText(/already look like German/)).toBeVisible();
  await expect(page.getByText(/Pick a different target language/)).toBeVisible();

  // Section 3.3's refusal happens before the charge, so the wallet has not
  // moved and the upload is still there to fix.
  await expectBalanceCents(page, FREE_BALANCE_CENTS);
  await expect(fileRow(page, "der-leuchtturm.srt")).toBeVisible();

  await openMenu(page, "Wallet");
  await expect(page.getByText("Nothing has moved yet")).toHaveCount(0);
  await expect(page.getByText("Free starting balance")).toBeVisible();
});
