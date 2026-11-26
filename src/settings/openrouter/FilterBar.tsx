import { Search } from "lucide-react";

export type SortOption = "newest" | "price_asc" | "price_desc" | "context_desc";

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  sort: SortOption;
  onSortChange: (value: SortOption) => void;
  freeOnly: boolean;
  onFreeOnlyChange: (value: boolean) => void;
  filterTools: boolean;
  onFilterToolsChange: (value: boolean) => void;
  filterReasoning: boolean;
  onFilterReasoningChange: (value: boolean) => void;
  filterWebSearch: boolean;
  onFilterWebSearchChange: (value: boolean) => void;
}

export function FilterBar({
  search,
  onSearchChange,
  sort,
  onSortChange,
  freeOnly,
  onFreeOnlyChange,
  filterTools,
  onFilterToolsChange,
  filterReasoning,
  onFilterReasoningChange,
  filterWebSearch,
  onFilterWebSearchChange,
}: FilterBarProps) {
  return (
    <div className="space-y-2.5">
      {/* Search + Sort row */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40" />
          <input
            type="text"
            placeholder="Search models..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full rounded-lg border border-border/30 bg-background/50 pl-8 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/30 focus:border-ring focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortOption)}
          className="rounded-lg border border-border/30 bg-background/50 px-3 py-2 text-xs text-foreground focus:border-ring focus:outline-none cursor-pointer min-w-[150px]"
        >
          <option value="newest">Newest first</option>
          <option value="price_asc">Price: low → high</option>
          <option value="price_desc">Price: high → low</option>
          <option value="context_desc">Context: high → low</option>
        </select>
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-1.5">
        <Chip
          label="Free only"
          active={freeOnly}
          onClick={() => onFreeOnlyChange(!freeOnly)}
          variant="free"
        />
        <div className="w-px h-4 bg-border/20 mx-1" />
        <Chip
          label="Tools"
          active={filterTools}
          onClick={() => onFilterToolsChange(!filterTools)}
        />
        <Chip
          label="Reasoning"
          active={filterReasoning}
          onClick={() => onFilterReasoningChange(!filterReasoning)}
        />
        <Chip
          label="Web search"
          active={filterWebSearch}
          onClick={() => onFilterWebSearchChange(!filterWebSearch)}
        />
      </div>
    </div>
  );
}

function Chip({
  label,
  active,
  onClick,
  variant,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  variant?: "free";
}) {
  const activeClass =
    variant === "free"
      ? "bg-green-500/12 border-green-500/30 text-green-500"
      : "bg-primary/12 border-primary/30 text-primary";

  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-[11px] border transition-all duration-150 cursor-pointer ${
        active
          ? activeClass
          : "border-border/20 text-muted-foreground/50 hover:border-border/40 hover:text-muted-foreground/70"
      }`}
    >
      {label}
    </button>
  );
}
