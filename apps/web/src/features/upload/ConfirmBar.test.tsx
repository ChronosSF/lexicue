import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmBar } from "./ConfirmBar.js";

/** The exact wording of spec section 2.1, step 4. */
describe("ConfirmBar", () => {
  const base = {
    balanceCents: 1240,
    shortfall: null,
    blockedBecause: null,
    pending: false,
    error: null,
    onTranslate: () => undefined,
    onTopUp: () => undefined,
  };

  it("names the count and the price", () => {
    render(<ConfirmBar {...base} fileCount={8} totalCents={420} />);
    expect(screen.getByRole("button", { name: "Translate 8 files · $4.20" })).toBeInTheDocument();
    expect(screen.getByText(/balance/i).textContent).toContain("$12.40");
  });

  it("says one file in the singular", () => {
    render(<ConfirmBar {...base} fileCount={1} totalCents={90} />);
    expect(screen.getByRole("button", { name: "Translate 1 file · $0.90" })).toBeInTheDocument();
  });

  it("offers the top-up that covers the shortfall instead of refusing", async () => {
    const onTopUp = vi.fn();
    render(
      <ConfirmBar
        {...base}
        fileCount={8}
        totalCents={420}
        balanceCents={120}
        shortfall={{ shortfallCents: 300, suggestedTopUpCents: 500 }}
        onTopUp={onTopUp}
      />,
    );

    const button = screen.getByRole("button", { name: "Top up $5 and translate" });
    await userEvent.click(button);
    expect(onTopUp).toHaveBeenCalledWith(500);
    expect(screen.queryByRole("button", { name: /^Translate/ })).not.toBeInTheDocument();
  });

  it("will not translate while something is missing", () => {
    render(
      <ConfirmBar
        {...base}
        fileCount={2}
        totalCents={200}
        blockedBecause="Choose a target language."
      />,
    );
    expect(screen.getByRole("button", { name: /Translate/ })).toBeDisabled();
    expect(screen.getByText("Choose a target language.")).toBeInTheDocument();
  });

  it("shows money, never credits", () => {
    render(<ConfirmBar {...base} fileCount={3} totalCents={144} />);
    expect(document.body.textContent).toContain("$1.44");
    expect(document.body.textContent).not.toMatch(/credits?\b/i);
  });
});
