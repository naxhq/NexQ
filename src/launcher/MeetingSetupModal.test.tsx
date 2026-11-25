import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingSetupModal } from "./MeetingSetupModal";
import { useConfigStore } from "../stores/configStore";
import { useScenarioStore } from "../stores/scenarioStore";
import { FALLBACK_GENERAL, useWorkspaceStore } from "../stores/workspaceStore";
import type { AIScenario, ScenarioTemplate } from "../lib/types";

const boardReview = {
  id: "custom_1",
  name: "Board review",
  description: "Custom scenario",
  is_custom: true,
} as ScenarioTemplate;

const start = () => fireEvent.click(screen.getByRole("button", { name: "Start Meeting" }));

function remember(scenario: AIScenario) {
  useConfigStore.setState({ rememberedMeetingSetup: { audioMode: "online", scenario } });
}

beforeAll(() => {
  mockWindows("launcher");
  mockIPC(() => []);
});

beforeEach(() => {
  useScenarioStore.setState({ customScenarios: [boardReview] });
});

afterEach(() => {
  cleanup();
  useConfigStore.setState({ rememberedMeetingSetup: null });
  useScenarioStore.setState({ customScenarios: [] });
});

describe("MeetingSetupModal scenarios", () => {
  it("offers custom scenarios and starts the chosen one", () => {
    const onStart = vi.fn();
    render(<MeetingSetupModal open onStart={onStart} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Team Meeting" }));
    fireEvent.click(screen.getByRole("button", { name: /Board review/ }));
    start();
    expect(onStart).toHaveBeenCalledWith("online", "custom_1", { workspaceId: "general", borrowed: [] });
  });

  it("shows a remembered custom scenario by name", () => {
    remember("custom_1");
    const onStart = vi.fn();
    render(<MeetingSetupModal open onStart={onStart} onCancel={() => {}} />);
    expect(screen.getByText("Board review")).toBeInTheDocument();
    start();
    expect(onStart).toHaveBeenCalledWith("online", "custom_1", { workspaceId: "general", borrowed: [] });
  });

  it("falls back to Team Meeting when the remembered scenario was deleted", () => {
    remember("custom_deleted");
    const onStart = vi.fn();
    render(<MeetingSetupModal open onStart={onStart} onCancel={() => {}} />);
    expect(screen.getByText("Team Meeting")).toBeInTheDocument();
    expect(screen.queryByText("custom_deleted")).toBeNull();
    start();
    expect(onStart).toHaveBeenCalledWith("online", "team_meeting", { workspaceId: "general", borrowed: [] });
  });
});

describe("MeetingSetupModal workspaces", () => {
  const start2 = () => fireEvent.click(screen.getByRole("button", { name: "Start Meeting" }));
  const a = { id: "a", name: "Acme", description: "", default_scenario: null, keep_separate: false, archived: false, is_default: false } as never;
  const b = { id: "b", name: "Biology", description: "", default_scenario: "interview", keep_separate: false, archived: false, is_default: false } as never;
  const k = { id: "k", name: "Vault", description: "", default_scenario: null, keep_separate: true, archived: false, is_default: false } as never;
  const general = { id: "general", name: "General", description: "", default_scenario: null, keep_separate: false, archived: false, is_default: true } as never;

  beforeEach(() => {
    useWorkspaceStore.setState({ workspaces: [general, a, b, k] });
  });
  afterEach(() => {
    useWorkspaceStore.setState({ workspaces: [FALLBACK_GENERAL] });
  });

  it("hides the choice when there is only General", () => {
    useWorkspaceStore.setState({ workspaces: [FALLBACK_GENERAL] });
    render(<MeetingSetupModal open onStart={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole("radiogroup", { name: "Workspace" })).toBeNull();
  });

  it("starts in the workspace that is open, and can change it", () => {
    const onStart = vi.fn();
    render(<MeetingSetupModal open workspaceId="a" onStart={onStart} onCancel={() => {}} />);
    expect(screen.getByRole("radio", { name: "Acme" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Biology" }));
    start2();
    expect(onStart).toHaveBeenCalledWith("online", "interview", { workspaceId: "b", borrowed: [] });
  });

  it("the workspace's scenario applies until one is picked here", () => {
    const onStart = vi.fn();
    render(<MeetingSetupModal open workspaceId="b" onStart={onStart} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Interview" })).toBeInTheDocument();
    // An explicit pick wins, and survives a change of workspace.
    fireEvent.click(screen.getByRole("button", { name: "Interview" }));
    fireEvent.click(screen.getByRole("button", { name: /Board review/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Acme" }));
    start2();
    expect(onStart).toHaveBeenCalledWith("online", "custom_1", { workspaceId: "a", borrowed: [] });
  });

  it("offers Also use, blocks kept-separate combinations with the reason, and drops a borrowed home", () => {
    const onStart = vi.fn();
    render(<MeetingSetupModal open workspaceId="a" onStart={onStart} onCancel={() => {}} />);
    const vault = screen.getByRole("checkbox", { name: /Vault/ });
    expect(vault).toBeDisabled();
    expect(screen.getByText("Kept separate")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Biology/ }));
    start2();
    expect(onStart).toHaveBeenLastCalledWith("online", expect.any(String), { workspaceId: "a", borrowed: ["b"] });
    // Moving the home onto the borrowed one removes it from "Also use".
    fireEvent.click(screen.getByRole("radio", { name: "Biology" }));
    start2();
    expect(onStart).toHaveBeenLastCalledWith("online", expect.any(String), { workspaceId: "b", borrowed: [] });
  });
});
