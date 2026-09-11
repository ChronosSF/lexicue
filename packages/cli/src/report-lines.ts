import { formatCents } from "@lexicue/pricing";
import { formatUsd, type FileReport, type UploadReport } from "@lexicue/harness";

/** The per-file block the command line prints (spec section 9.9). */
export function formatFileReport(report: FileReport, outputPath: string): string[] {
  const lines: string[] = [];
  lines.push(`${report.file} -> ${outputPath}`);
  lines.push(
    `  ${count(report.totalCues, "cue")}, ${report.dialogueChars.toLocaleString("en-US")} characters of dialogue, ${report.format}, ${report.encoding}`,
  );
  lines.push(
    `  price ${formatCents(report.priceCents)} on the ${report.lane} lane · model cost ${formatUsd(report.modelCostUsd)} · ${(report.wallTimeMs / 1000).toFixed(1)} s`,
  );
  lines.push(
    `  ${report.model}, effort ${report.effort}, ${count(report.batches, "batch", "batches")}, prompt ${report.promptVersion}`,
  );
  lines.push(
    `  tokens: ${report.usage.inputTokens.toLocaleString("en-US")} in, ${report.usage.outputTokens.toLocaleString("en-US")} out, ${report.usage.cacheReadInputTokens.toLocaleString("en-US")} cache reads, ${report.usage.cacheCreationInputTokens.toLocaleString("en-US")} cache writes`,
  );

  if (report.glossaryEntriesApplied > 0) {
    lines.push(
      `  glossary: ${count(report.glossaryEntriesApplied, "entry", "entries")} applied${report.seasonGlossaryApplied ? ", shared across the upload" : ""}`,
    );
  }
  if (report.untranslatedCues.length > 0) {
    lines.push(`  ${count(report.untranslatedCues.length, "cue")} left in the source language:`);
    for (const cue of report.untranslatedCues.slice(0, 10)) {
      lines.push(`    ${cue.index ?? `#${cue.id.toString()}`} ${cue.timing} — ${cue.reason}`);
    }
    if (report.untranslatedCues.length > 10) {
      lines.push(`    ... and ${(report.untranslatedCues.length - 10).toString()} more`);
    }
  }
  if (report.readingSpeedFindings.length > 0) {
    lines.push(
      `  advisory: ${count(report.readingSpeedFindings.length, "cue")} over 20 characters per second`,
    );
  }
  if (report.longLines.length > 0) {
    lines.push(`  advisory: ${count(report.longLines.length, "line")} over 42 characters`);
  }
  if (report.fallbackModelUsed) {
    lines.push("  the fallback model was used for at least one batch");
  }
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  return lines;
}

/** The batch summary a multi-file upload adds (spec section 3.5). */
export function formatUploadSummary(report: UploadReport): string[] {
  const lines: string[] = [];
  lines.push(
    `${count(report.files.length, "file")}, ${report.totalCues.toLocaleString("en-US")} cues, ${report.totalDialogueChars.toLocaleString("en-US")} characters of dialogue`,
  );
  lines.push(
    `price ${formatCents(report.totalPriceCents)} · model cost ${formatUsd(report.totalModelCostUsd)}`,
  );
  const season = report.seasonGlossary;
  if (season !== null) {
    lines.push(
      `season glossary: ${count(season.characters, "character")}, ${count(season.terms, "term")}, ${count(season.styleNotes, "style note")}, sampled from ${count(season.sampledFiles.length, "file")}`,
    );
    if (season.droppedFiles.length > 0) {
      lines.push(
        `  the token cap left ${count(season.droppedFiles.length, "file")} out of the sample: ${season.droppedFiles.join(", ")}`,
      );
    }
  }
  return lines;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : plural}`;
}
