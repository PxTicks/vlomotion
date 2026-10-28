import { useEffect } from "react";
import { FPS } from "@h3-motion/shared";

/** The store state and actions the editor shortcuts drive; the motion and inpainting stores both provide them. */
export interface ShortcutActions { playhead: number; togglePlay(): void; addKey(): void; deleteSelected(): void; setPlayhead(frame: number): void }

/** Space plays, K adds a key, Delete removes the selected key and the arrows step frames (a second with Shift). */
export function useMotionShortcuts(actions: () => ShortcutActions, { enabled = true, readOnly = false }: { enabled?: boolean; readOnly?: boolean } = {}) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const store = actions();
      if (event.key === " " && !target?.closest("button, [role='slider']")) { event.preventDefault(); store.togglePlay(); }
      else if (!readOnly && (event.key === "k" || event.key === "K")) store.addKey();
      else if (!readOnly && (event.key === "Delete" || event.key === "Backspace")) { event.preventDefault(); store.deleteSelected(); }
      else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !target?.closest("[role='slider'], [role='group']")) {
        event.preventDefault();
        store.setPlayhead(store.playhead + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? FPS : 1));
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [actions, enabled, readOnly]);
}
