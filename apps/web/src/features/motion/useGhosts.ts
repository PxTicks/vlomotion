import { create } from "zustand";

/** Whether editors draw the dragged subject or mask faintly at each of its keys. Shared, so one toggle covers both editors. */
export const useGhosts = create<{ show: boolean; toggle(): void }>(set => ({
  show: true,
  toggle: () => set(state => ({ show: !state.show })),
}));
