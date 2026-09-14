import { expect, test } from "@playwright/test";
import {
  FREE_BALANCE_CENTS,
  chooseLane,
  chooseLanguage,
  download,
  expectBalanceCents,
  previewPriceCents,
  sample,
  signInAndVerify,
  timingLines,
  sampleText,
} from "./support.js";

/**
 * The economy lane of spec sections 2.1 and 6.2: a third cheaper, "usually
 * within the hour, at most 24 hours", and the page says the user can leave.
 * The mock runs that hour in twelve seconds, and the file that comes back is
 * held to the same structural guarantee as the fast lane's.
 */

const FILE = "the-keepers.srt";

test("submits to the economy lane with its own notice, and the file still comes back intact", async ({
  page,
}) => {
  await signInAndVerify(page, "economy@example.com");

  await sample(page, "The Keepers").click();

  const fastCents = await previewPriceCents(page, FILE, "Fast");
  const economyCents = await previewPriceCents(page, FILE, "Economy");
  // A 27-cue documentary is under the minimum price of spec section 6.1 on
  // both lanes, so the lane cards are where the third off is visible.
  expect(economyCents).toBeLessThanOrEqual(fastCents);

  await chooseLanguage(page, "French");
  await chooseLane(page, "Economy");

  // The rate and the delivery promise are on the card the user is choosing.
  const economyCard = page.getByRole("radio", { name: /^Economy\s/ });
  await expect(economyCard).toBeChecked();
  await expect(economyCard).toHaveAccessibleName(/Usually within the hour, at most 24 hours/);
  await expect(economyCard).toHaveAccessibleName(/2c per 1,000 characters of dialogue/);
  await expect(page.getByRole("radio", { name: /^Fast\s/ })).toHaveAccessibleName(
    /3c per 1,000 characters of dialogue/,
  );

  const confirm = page.getByRole("button", { name: /^Translate 1 file/ });
  await confirm.click();

  // Submitted, not running: the page says the wait is an hour and that an email
  // will arrive, so there is nothing to sit and watch.
  await expect(page.getByText(/usually come back within the hour/)).toBeVisible();
  await expect(page.getByText(/an email arrives when the upload is complete/)).toBeVisible();
  await expect(page.getByText("Submitted to the batch")).toBeVisible();

  // And then it lands, in the mock's compressed time.
  await expect(page.getByRole("heading", { name: "Your file is ready" })).toBeVisible({
    timeout: 40_000,
  });

  const saved = await download(page, page.getByRole("link", { name: "Download", exact: true }));
  expect(saved.fileName).toBe("the-keepers.fr.srt");
  expect(timingLines(saved.bytes.toString("utf8"), saved.fileName)).toEqual(
    timingLines(sampleText(FILE), FILE),
  );

  await expectBalanceCents(page, FREE_BALANCE_CENTS - economyCents);
});
