import { unzipSync } from "fflate";
import { expect, test } from "@playwright/test";
import {
  FREE_BALANCE_CENTS,
  centsIn,
  chooseLane,
  chooseLanguage,
  cueCount,
  download,
  expectBalanceCents,
  previewPriceCents,
  sampleText,
  signInAndVerify,
  timingLines,
} from "./support.js";

/**
 * A whole season at once: three episodes that share one glossary, and the
 * "Download all" zip of spec section 2.1 step 6, unpacked here and parsed file
 * by file. This is the upload shape the product is actually sold on — a
 * file-at-a-time tool cannot carry a name from episode one to episode three.
 */

const EPISODES = [
  { path: "season/skerry-point-s01e01.srt", file: "skerry-point-s01e01.srt" },
  { path: "season/skerry-point-s01e02.srt", file: "skerry-point-s01e02.srt" },
  { path: "season/skerry-point-s01e03.srt", file: "skerry-point-s01e03.srt" },
];

test("translates three episodes at once and downloads them as one zip", async ({ page }) => {
  await signInAndVerify(page, "season@example.com");

  await page.getByRole("button", { name: "Add all 3 episodes" }).click();

  let previewedCents = 0;
  for (const episode of EPISODES) {
    previewedCents += await previewPriceCents(page, episode.file, "Fast");
  }

  await chooseLanguage(page, "German");
  await chooseLane(page, "Fast");

  const confirm = page.getByRole("button", { name: /^Translate 3 files/ });
  expect(centsIn(await confirm.textContent())).toBe(previewedCents);
  await confirm.click();

  await expect(page.getByRole("heading", { name: "Your files are ready" })).toBeVisible({
    timeout: 40_000,
  });

  // The shared glossary is the batch's own summary, under the files.
  await expect(page.getByRole("heading", { name: "Season glossary" })).toBeVisible();

  const saved = await download(page, page.getByRole("link", { name: /^Download all/ }));
  expect(saved.fileName).toMatch(/^subtitles-de-.*\.zip$/);

  const unpacked = unzipSync(new Uint8Array(saved.bytes));
  expect(Object.keys(unpacked).sort()).toEqual(
    EPISODES.map((episode) => episode.file.replace(/\.srt$/, ".de.srt")).sort(),
  );

  for (const episode of EPISODES) {
    const name = episode.file.replace(/\.srt$/, ".de.srt");
    const translated = Buffer.from(unpacked[name] ?? new Uint8Array()).toString("utf8");
    const source = sampleText(episode.path);
    expect(cueCount(translated, name), `${name} has the cues of its source`).toBe(
      cueCount(source, episode.file),
    );
    expect(timingLines(translated, name), `${name} keeps every timing line`).toEqual(
      timingLines(source, episode.file),
    );
  }

  await expectBalanceCents(page, FREE_BALANCE_CENTS - previewedCents);
});
