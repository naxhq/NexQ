import { useCallback, useState } from "react";

const KEY = "nexq_favorites";

/** Starred meetings (kept in this window's storage, as before). */
export function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(KEY);
      return stored ? new Set<string>(JSON.parse(stored)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {
        /* storage unavailable: the star lasts until the window closes */
      }
      return next;
    });
  }, []);
  return { favorites, toggleFavorite };
}
