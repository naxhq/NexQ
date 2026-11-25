import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: { provider?: string }) => {
    if (cmd === "list_models") {
      const p = JSON.parse(args?.provider ?? "{}").provider_type;
      if (p === "ollama") return "[]"; // a local server that is up
      throw new Error("not reachable");
    }
    return null;
  }),
);
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

import { ServiceStatusBar } from "./ServiceStatusBar";
import { useConfigStore } from "../stores/configStore";

function open() {
  render(<ServiceStatusBar compact />);
  fireEvent.click(screen.getByTitle(/^LLM:/));
}

describe("the AI provider picker in the footer", () => {
  beforeEach(() => {
    useConfigStore.setState({
      llmProvider: "lm_studio",
      llmModel: "qwen",
      verifiedCloudProviders: ["lm_studio"],
      customLlmBaseUrl: "http://10.0.0.5:8080/v1",
      lastModelByProvider: { custom: "mock-model" },
    });
  });
  afterEach(cleanup);

  it("keeps a configured Custom endpoint in the list while another provider is active, with its host", async () => {
    open();
    expect(await screen.findByRole("button", { name: /Custom/ })).toBeInTheDocument();
    expect(screen.getByText("10.0.0.5:8080")).toBeInTheDocument();
  });

  it("offers Custom's own model instead of 'No models available'", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Custom/ }));
    await waitFor(() => expect(screen.queryByText(/No models available/)).toBeNull());
    expect(await screen.findByText("mock-model")).toBeInTheDocument();
  });

  it("a local server that came up while the app ran appears when the picker opens, labelled running", async () => {
    useConfigStore.setState({ verifiedCloudProviders: ["lm_studio"] });
    open();
    expect(await screen.findByRole("button", { name: /Ollama/ })).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("does not switch the provider by itself", async () => {
    open();
    await screen.findByRole("button", { name: /Ollama/ });
    expect(useConfigStore.getState().llmProvider).toBe("lm_studio");
  });

  it("looks again each time it opens", async () => {
    open();
    await screen.findByRole("button", { name: /Ollama/ });
    const first = invoke.mock.calls.filter((c) => c[0] === "list_models").length;
    fireEvent.click(screen.getByTitle(/^LLM:/)); // close
    fireEvent.click(screen.getByTitle(/^LLM:/)); // open again
    await waitFor(() => expect(invoke.mock.calls.filter((c) => c[0] === "list_models").length).toBeGreaterThan(first));
  });

  it("has no Custom entry when no endpoint is configured", async () => {
    useConfigStore.setState({ customLlmBaseUrl: "" });
    open();
    await screen.findByRole("button", { name: /Ollama/ });
    expect(screen.queryByRole("button", { name: /Custom/ })).toBeNull();
  });
});
