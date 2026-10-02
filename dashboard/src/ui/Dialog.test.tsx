import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChoiceDialog, ConfirmDialog, PromptDialog } from ".";

describe("shared dialogs", () => {
  it("traps keyboard focus, closes on Escape, and restores focus", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button>{open && <ConfirmDialog title="Remove alias?" body="This cannot be undone." onConfirm={() => {}} onCancel={() => setOpen(false)} />}</>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    expect(screen.getByRole("alertdialog", { name: "Remove alias?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("submits prompt values with Enter", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<PromptDialog title="Rename" body="New name" defaultValue="old" onConfirm={onConfirm} onCancel={() => {}} />);
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "new{Enter}");
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith("new");
  });

  it("exposes choice actions in a labelled dialog", async () => {
    const primary = vi.fn();
    const user = userEvent.setup();
    render(<ChoiceDialog title="Recovery" body="Choose delivery" primaryLabel="Email" secondaryLabel="Copy link" onPrimary={primary} onSecondary={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Recovery" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Email" }));
    expect(primary).toHaveBeenCalledOnce();
  });
});
