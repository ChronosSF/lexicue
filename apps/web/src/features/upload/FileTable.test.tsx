import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_RATE_TABLE } from "@lexicue/pricing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileTable } from "./FileTable.js";
import { intake } from "./local-files.js";

const SAMPLES = [
  resolve(process.cwd(), "public/samples"),
  resolve(process.cwd(), "apps/web/public/samples"),
].find((candidate) => existsSync(candidate));

function sample(path: string): { name: string; bytes: Uint8Array } {
  if (SAMPLES === undefined) throw new Error("the sample files are missing");
  return {
    name: path.split("/").pop() ?? path,
    bytes: new Uint8Array(readFileSync(resolve(SAMPLES, path))),
  };
}

describe("FileTable", () => {
  it("shows what the app understood and the price on both lanes", () => {
    const { files } = intake([sample("the-lamp-room.srt")]);
    render(
      <FileTable files={files} lane="fast" rates={DEFAULT_RATE_TABLE} onRemove={() => undefined} />,
    );

    const row = screen.getByRole("row", { name: /the-lamp-room\.srt/ });
    expect(within(row).getByText("SubRip")).toBeInTheDocument();
    expect(within(row).getByText("utf-8")).toBeInTheDocument();
    expect(within(row).getByText("38")).toBeInTheDocument();
    // The 10-cent minimum applies to a file this small, on both lanes.
    expect(within(row).getAllByText("$0.10")).toHaveLength(2);
  });

  it("explains an unusable file in place and still lets it be removed", async () => {
    const { files } = intake([
      sample("the-lamp-room.srt"),
      { name: "poster.srt", bytes: new TextEncoder().encode("this is not a subtitle file") },
    ]);
    const onRemove = vi.fn();
    render(
      <FileTable files={files} lane="economy" rates={DEFAULT_RATE_TABLE} onRemove={onRemove} />,
    );

    expect(screen.getByText(/format was not recognised/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove poster.srt" }));
    expect(onRemove).toHaveBeenCalledWith(files[1]?.id);
  });

  it("marks the lane the user chose", () => {
    const { files } = intake([sample("the-last-tender.srt")]);
    const { container } = render(
      <FileTable
        files={files}
        lane="economy"
        rates={DEFAULT_RATE_TABLE}
        onRemove={() => undefined}
      />,
    );
    const chosen = container.querySelectorAll("td.price.is-chosen");
    expect(chosen).toHaveLength(1);
  });
});
