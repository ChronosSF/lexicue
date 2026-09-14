import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { MockBackend } from "./backend/mock/adapter.js";
import { bytesToBase64 } from "./backend/mock/bytes.js";
import type { SampleFile } from "./backend/types.js";
import { renderWithBackend } from "./testing/render.js";

/**
 * The three states of spec section 2, clicked through the way a user does:
 * choose a file, choose a language, confirm a price, watch it run, download
 * what comes back. The backend is the mock, with its clock shortened.
 */

const SAMPLES = [
  resolve(process.cwd(), "public/samples"),
  resolve(process.cwd(), "apps/web/public/samples"),
].find((candidate) => existsSync(candidate));

function sampleBytes(path: string): Uint8Array {
  if (path === "a-long-film.srt") return longFilm();
  if (SAMPLES === undefined) throw new Error("the sample files are missing");
  return new Uint8Array(readFileSync(resolve(SAMPLES, path)));
}

/**
 * Enough dialogue to cost more than the demo's $12.30: 6,000 cues and 948,000
 * characters is $14.28 on the fast lane, at 1 cent per 1,000 characters plus
 * 8 cents per 100 cues. It has to clear the balance by less than $5, so that
 * the smallest top-up is the one offered.
 */
function longFilm(): Uint8Array {
  const line = "Every line of this file carries a great many billable characters indeed, truly.";
  const cues = Array.from({ length: 6_000 }, (_unused, index) => {
    const second = index % 60;
    const stamp = (value: number): string => value.toString().padStart(2, "0");
    const timing = `00:00:${stamp(second)},000 --> 00:00:${stamp((second + 1) % 60)},500`;
    return [(index + 1).toString(), timing, line, line].join("\n");
  });
  return new TextEncoder().encode(`${cues.join("\n\n")}\n`);
}

const SAMPLE_LIST: SampleFile[] = [
  {
    path: "the-lamp-room.srt",
    fileName: "the-lamp-room.srt",
    title: "The Lamp Room",
    description: "Two keepers, one lamp and a running joke.",
    format: "srt",
    sourceLanguage: "en",
    cues: 38,
  },
  {
    path: "a-long-film.srt",
    fileName: "a-long-film.srt",
    title: "A very long film",
    description: "More dialogue than the balance covers.",
    format: "srt",
    sourceLanguage: "en",
    cues: 3000,
  },
  {
    path: "fail.srt",
    fileName: "fail.srt",
    title: "fail.srt",
    description: "Fails on purpose, to show the refund.",
    format: "srt",
    sourceLanguage: "en",
    cues: 38,
    fails: true,
  },
];

function backend(): MockBackend {
  return new MockBackend({
    seedDemo: true,
    loadSample: (path) => Promise.resolve(sampleBytes(path)),
    loadSampleList: () => Promise.resolve(SAMPLE_LIST),
    createDownloadUrl: (bytes, mime) => `data:${mime};base64,${bytesToBase64(bytes)}`,
    timing: {
      fastBaseMs: 40,
      fastPerCharMs: 0,
      fastMaxMs: 40,
      economyMs: 40,
      pollFastMs: 20,
      pollEconomyMs: 20,
      checkoutSettleMs: 10,
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

describe("the translate flow", () => {
  it("goes from a sample file to a downloadable translation", async () => {
    const user = userEvent.setup();
    const mock = backend();
    renderWithBackend(<App backend={mock} />, mock);

    // The demo starts signed in and verified, with its balance in the header.
    expect(await screen.findByText(/free credit/)).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /The Lamp Room/ }));

    const row = await screen.findByRole("row", { name: /the-lamp-room\.srt/ });
    expect(within(row).getByText("SubRip")).toBeInTheDocument();

    // Choosing the language is what unblocks the confirm button.
    expect(screen.getByRole("button", { name: /Translate 1 file/ })).toBeDisabled();
    await user.type(screen.getByRole("combobox", { name: /target language/i }), "German");
    await user.click(await screen.findByRole("option", { name: /German/ }));

    const confirm = await screen.findByRole("button", { name: "Translate 1 file · $0.10" });
    await user.click(confirm);

    expect(
      await screen.findByText(/Your file is ready/, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();

    const download = screen.getByRole("link", { name: "Download" });
    expect(download).toHaveAttribute("download", "the-lamp-room.de.srt");

    // The report is one click away and knows what happened.
    await user.click(screen.getByRole("button", { name: "Report" }));
    expect(await screen.findByText(/38 of 38 cues/)).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
  }, 20_000);

  it("refunds a file that fails and says so in its row", async () => {
    const user = userEvent.setup();
    const mock = backend();
    renderWithBackend(<App backend={mock} />, mock);

    await user.click(await screen.findByRole("button", { name: /fail\.srt/ }));
    await user.type(screen.getByRole("combobox", { name: /target language/i }), "French");
    await user.click(await screen.findByRole("option", { name: /French/ }));
    await user.click(await screen.findByRole("button", { name: /Translate 1 file/ }));

    expect(
      await screen.findByText(/refunded to your balance/, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing could be translated/)).toBeInTheDocument();
  }, 20_000);

  it("offers a top-up instead of refusing when the balance is short", async () => {
    const user = userEvent.setup();
    const mock = backend();
    renderWithBackend(<App backend={mock} />, mock);

    // A film with more dialogue than the demo's balance covers.
    await user.click(await screen.findByRole("button", { name: /A very long film/ }));
    await user.type(screen.getByRole("combobox", { name: /target language/i }), "Polish");
    await user.click(await screen.findByRole("option", { name: /Polish/ }));

    expect(
      await screen.findByRole("button", { name: /Top up \$5 and translate/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/short of this upload/)).toBeInTheDocument();
  }, 30_000);
});

describe("the wallet and history", () => {
  it("shows the balance, the free portion and every transaction", async () => {
    const user = userEvent.setup();
    const mock = backend();
    renderWithBackend(<App backend={mock} />, mock);

    await user.click(await screen.findByRole("button", { name: /account menu/i }));
    await user.click(await screen.findByRole("menuitem", { name: /Wallet/ }));

    expect(await screen.findByText("Free starting balance")).toBeInTheDocument();
    expect(screen.getByText(/of free credit, which is spent before/)).toBeInTheDocument();
    expect(screen.getByText(/Top-up of \$10/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue to checkout/ })).toBeInTheDocument();
  }, 20_000);

  it("lists the seeded upload in the history and opens it", async () => {
    const user = userEvent.setup();
    const mock = backend();
    renderWithBackend(<App backend={mock} />, mock);

    await user.click(await screen.findByRole("button", { name: /account menu/i }));
    await user.click(await screen.findByRole("menuitem", { name: /History/ }));

    const row = await screen.findByRole("button", { name: /skerry-point/ });
    expect(within(row).getByText("Delivered")).toBeInTheDocument();

    await user.click(row);
    expect(await screen.findByText(/Season glossary/)).toBeInTheDocument();
  }, 20_000);
});
