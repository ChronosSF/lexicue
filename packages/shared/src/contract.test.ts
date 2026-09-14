import {
  DEFAULT_HARNESS_CONFIG,
  TARGET_LANGUAGES,
  buildFileReport,
  emptyUsage,
  findTargetLanguage,
  type Formality as HarnessFormality,
  type LineHandling as HarnessLineHandling,
} from "@lexicue/harness";
import {
  FREE_BALANCE_CENTS,
  LANES,
  DEFAULT_RATE_TABLE,
  meteredOf,
  TOP_UP_AMOUNTS_CENTS,
  priceCents,
  type Lane as PricingLane,
} from "@lexicue/pricing";
import { parseSubtitleText } from "@lexicue/subtitles";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ApiError,
  ApiErrorBodySchema,
  CreateBatchRequestSchema,
  DEFAULT_TRANSLATION_OPTIONS,
  FileReportSchema,
  LanguagesResponseSchema,
  PricingResponseSchema,
  isInsufficientBalance,
  rateTableOf,
  routePath,
  type Formality,
  type Lane,
  type LineHandling,
} from "./index.js";

const SOURCE = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "- Don't tell me you forgot.",
  "- <i>Never.</i>",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,500",
  "The lamp room, then. Midnight.",
  "",
].join("\n");

describe("the contract and the packages it is shared with", () => {
  it("uses the same lane, formality and line-handling vocabularies as the harness", () => {
    expectTypeOf<Lane>().toEqualTypeOf<PricingLane>();
    expectTypeOf<Formality>().toEqualTypeOf<HarnessFormality>();
    expectTypeOf<LineHandling>().toEqualTypeOf<HarnessLineHandling>();
  });

  it("accepts a report the harness actually produced", () => {
    const document = parseSubtitleText(SOURCE, { fileName: "the-lamp-room.srt" });
    const target = findTargetLanguage("de");
    if (target === undefined) throw new Error("German is in the curated list");

    const report = buildFileReport({
      file: "the-lamp-room.srt",
      source: document,
      output: document,
      untranslated: [],
      glossaryEntriesApplied: 3,
      seasonGlossaryApplied: false,
      repairs: [],
      warnings: document.warnings,
      usage: emptyUsage(),
      wallTimeMs: 1234,
      batches: 1,
      model: DEFAULT_HARNESS_CONFIG.model,
      fallbackModelUsed: false,
      promptVersion: "v3",
      lane: "fast",
      target,
      config: DEFAULT_HARNESS_CONFIG,
    });

    const parsed = FileReportSchema.parse(report);
    expect(parsed.priceCents).toBe(priceCents(meteredOf(document), "fast"));
    expect(parsed.totalCues).toBe(2);
  });

  it("describes the pricing route with the numbers the price package holds", () => {
    const film = { dialogueChars: 60_000, cueCount: 1_400 };
    const response = PricingResponseSchema.parse({
      rates: LANES.map((lane) => ({
        lane,
        ...DEFAULT_RATE_TABLE[lane],
        delivery: lane === "fast" ? "About two minutes per film" : "Usually within the hour",
        description: "",
      })),
      topUpAmountsCents: [...TOP_UP_AMOUNTS_CENTS],
      defaultTopUpCents: 1000,
      freeBalanceCents: FREE_BALANCE_CENTS,
      examples: [
        {
          label: "Feature film, 2 h",
          ...film,
          fastCents: priceCents(film, "fast"),
          economyCents: priceCents(film, "economy"),
        },
      ],
    });
    expect(response.examples[0]).toMatchObject({ fastCents: 180, economyCents: 120 });
  });

  /**
   * The whole rate table crosses the wire, and comes back as the table the
   * browser prices with. Without this the preview and the charge are two
   * constants that happen to agree rather than one number used twice.
   */
  it("carries the rate table to the browser intact", () => {
    const served = LANES.map((lane) => ({
      lane,
      ...DEFAULT_RATE_TABLE[lane],
      delivery: "",
      description: "",
    }));
    expect(rateTableOf(PricingResponseSchema.shape.rates.parse(served))).toEqual(
      DEFAULT_RATE_TABLE,
    );
  });

  it("falls back to today's rates for a lane an older deployment did not serve", () => {
    const served = [
      {
        lane: "fast" as const,
        centsPer1000Chars: 2,
        centsPer100Cues: 5,
        minimumPriceCents: 25,
        delivery: "",
        description: "",
      },
    ];
    expect(rateTableOf(served)).toEqual({
      fast: { centsPer1000Chars: 2, centsPer100Cues: 5, minimumPriceCents: 25 },
      economy: DEFAULT_RATE_TABLE.economy,
    });
  });

  it("carries every curated target language, variants included", () => {
    const response = LanguagesResponseSchema.parse({ languages: TARGET_LANGUAGES });
    expect(response.languages).toHaveLength(TARGET_LANGUAGES.length);
    expect(response.languages.map((language) => language.code)).toEqual(
      expect.arrayContaining(["es", "es-419", "pt-BR", "pt-PT", "zh-Hans", "zh-Hant", "sr-Cyrl"]),
    );
  });
});

describe("request validation", () => {
  it("accepts a well-formed batch request", () => {
    const request = CreateBatchRequestSchema.parse({
      uploadIds: ["upl_1", "upl_2"],
      targetLanguage: "de",
      lane: "economy",
      options: DEFAULT_TRANSLATION_OPTIONS,
    });
    expect(request.options.outputBom).toBe(true);
  });

  it("refuses more than the 50 files an upload may carry", () => {
    const uploadIds = Array.from({ length: 51 }, (_unused, index) => `upl_${index.toString()}`);
    expect(
      CreateBatchRequestSchema.safeParse({
        uploadIds,
        targetLanguage: "de",
        lane: "fast",
        options: DEFAULT_TRANSLATION_OPTIONS,
      }).success,
    ).toBe(false);
  });

  it("refuses a context note over the 500-character limit", () => {
    expect(
      CreateBatchRequestSchema.safeParse({
        uploadIds: ["upl_1"],
        targetLanguage: "de",
        lane: "fast",
        options: { ...DEFAULT_TRANSLATION_OPTIONS, contextNote: "x".repeat(501) },
      }).success,
    ).toBe(false);
  });
});

describe("errors", () => {
  it("carries the shortfall the confirm button needs", () => {
    const body = ApiErrorBodySchema.parse({
      code: "insufficient-balance",
      message: "Your balance is $1.20 and this upload costs $4.20.",
      totalCents: 420,
      balanceCents: 120,
      shortfallCents: 300,
      suggestedTopUpCents: 500,
    });
    const error = new ApiError(body);
    expect(error.status).toBe(402);
    expect(isInsufficientBalance(error)).toBe(true);
    if (error.is("insufficient-balance")) expect(error.body.shortfallCents).toBe(300);
  });

  it("maps every code to one status", () => {
    const error = new ApiError({ code: "not-found", message: "That upload has expired." });
    expect(error.status).toBe(404);
    expect(isInsufficientBalance(error)).toBe(false);
  });
});

describe("route table", () => {
  it("fills path parameters", () => {
    expect(routePath("getBatch", { id: "bat_01" })).toBe("/api/batches/bat_01");
    expect(routePath("getMe")).toBe("/api/me");
  });
});
