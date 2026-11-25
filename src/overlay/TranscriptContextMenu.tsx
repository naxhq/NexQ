import { useEffect, useRef } from "react";
import { useKeepInWindow } from "../ui/portal";
import { Bookmark, BookmarkX, MessageSquarePlus, Copy } from "lucide-react";

interface TranscriptContextMenuProps {
  x: number;
  y: number;
  isBookmarked: boolean;
  onBookmark: () => void;
  onAddNote: () => void;
  onCopy: () => void;
  onClose: () => void;
}

export function TranscriptContextMenu({
  x, y, isBookmarked, onBookmark, onAddNote, onCopy, onClose,
}: TranscriptContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useKeepInWindow(ref);

  // Close on outside click or Escape
  useEffect(() => {
    const clickHandler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const escHandler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", clickHandler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", clickHandler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [onClose]);

  // Clamp menu to viewport boundaries
  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (rect.right > vw) {
        ref.current.style.left = `${vw - rect.width - 8}px`;
      }
      if (rect.bottom > vh) {
        ref.current.style.top = `${vh - rect.height - 8}px`;
      }
    }
  }, [x, y]);

  const items = [
    {
      icon: isBookmarked ? <BookmarkX className="h-3.5 w-3.5" /> : <Bookmark className="h-3.5 w-3.5" />,
      label: isBookmarked ? "Remove Bookmark" : "Bookmark",
      onClick: () => { onBookmark(); onClose(); },
    },
    {
      icon: <MessageSquarePlus className="h-3.5 w-3.5" />,
      label: "Add Note",
      onClick: () => { onAddNote(); onClose(); },
    },
    {
      icon: <Copy className="h-3.5 w-3.5" />,
      label: "Copy Text",
      onClick: () => { onCopy(); onClose(); },
    },
  ];

  return (
    <div
      ref={ref}
      className="fixed z-[9999] w-44 rounded-lg border border-white/10 py-1 shadow-2xl"
      style={{ left: x, top: y, backgroundColor: '#131320' }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.onClick}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground/70 hover:bg-secondary/30 hover:text-foreground cursor-pointer"
        >
          <span className="text-muted-foreground/50">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  );
}
