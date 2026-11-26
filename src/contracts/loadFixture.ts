// One contract fixture: the exact `invoke` arguments or event payload shared with the Rust
// tests in `src-tauri/src/contract.rs`. Change a fixture on one side and the other side's
// test fails until it follows.
const files = import.meta.glob("./fixtures/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

export function loadFixture<T = unknown>(name: string): T {
  const hit = files[`./fixtures/${name}.json`];
  if (hit === undefined) throw new Error(`no contract fixture named ${name}`);
  return hit as T;
}

export function fixtureNames(): string[] {
  return Object.keys(files).map((k) => k.replace("./fixtures/", "").replace(/\.json$/, "")).sort();
}
