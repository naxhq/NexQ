import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../lib/types";
import { ModelCombobox } from "./ModelCombobox";

const model = (id: string, context_window: number | null = null): ModelInfo => ({ id, name: id, provider: "custom", context_window });
const MODELS = [model("gemma4:31b", 131072), model("gpt-oss:120b"), model("qwen3-coder:480b")];

function setup(value = "gemma4:31b", models = MODELS) {
  const onCommit = vi.fn();
  render(<ModelCombobox value={value} models={models} onCommit={onCommit} />);
  return { onCommit, field: screen.getByRole("combobox", { name: "Model" }) };
}

describe("ModelCombobox", () => {
  afterEach(cleanup);

  it("takes a model name the provider didn't list, on Enter", () => {
    const { onCommit, field } = setup();
    fireEvent.change(field, { target: { value: "gemma4:31b-cloud" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("gemma4:31b-cloud");
  });

  it("takes a typed name when the field is left", () => {
    const { onCommit, field } = setup();
    fireEvent.change(field, { target: { value: "  gpt-oss:20b " } });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledWith("gpt-oss:20b");
    expect(field).toHaveValue("gpt-oss:20b");
  });

  it("works with no list at all", () => {
    const { onCommit, field } = setup("", []);
    expect(screen.queryByRole("button", { name: "Show models" })).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: "my-model" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("my-model");
  });

  it("shows every listed model from the arrow, and takes the one clicked", () => {
    const { onCommit } = setup();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Show models" }));
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["gemma4:31b (131K ctx)", "gpt-oss:120b", "qwen3-coder:480b"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.mouseDown(options[1]);
    expect(onCommit).toHaveBeenCalledWith("gpt-oss:120b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("narrows the list as you type, and the arrow keys pick from it", () => {
    const { onCommit, field } = setup();
    fireEvent.change(field, { target: { value: "QWEN" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["qwen3-coder:480b"]);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field).toHaveAttribute("aria-activedescendant", screen.getByRole("option").id);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("qwen3-coder:480b");
  });

  it("changes nothing for an empty or unchanged name, and Escape puts the model back", () => {
    const { onCommit, field } = setup();
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.blur(field);
    expect(field).toHaveValue("gemma4:31b");
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "gpt" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(field).toHaveValue("gpt");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field).toHaveValue("gemma4:31b");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows a model chosen elsewhere", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<ModelCombobox value="gemma4:31b" models={MODELS} onCommit={onCommit} />);
    rerender(<ModelCombobox value="gpt-oss:120b" models={MODELS} onCommit={onCommit} />);
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("gpt-oss:120b");
  });
});
