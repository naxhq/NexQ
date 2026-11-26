import { useDemoStore } from './demoStore';
import { exitDemo } from './demoEngine';

export function DemoBadge() {
  const isDemoActive = useDemoStore((s) => s.isDemoActive);

  if (!isDemoActive) return null;

  return (
    <button
      onClick={exitDemo}
      className="fixed bottom-4 right-4 z-[100] rounded-full bg-background border border-destructive/40 px-3 py-1.5 cursor-pointer transition-colors duration-150 hover:border-destructive/70"
      style={{ backgroundImage: "linear-gradient(hsl(var(--destructive) / 0.14), hsl(var(--destructive) / 0.14))" }}
      title="Exit demo mode (Ctrl+Shift+D)"
      aria-label="Exit demo mode"
    >
      <span className="text-[10px] font-bold text-destructive tracking-wider uppercase select-none">
        EXIT DEMO
      </span>
    </button>
  );
}
