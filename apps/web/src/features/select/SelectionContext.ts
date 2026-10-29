import { createContext, useContext } from "react";
import { useSelectionStore } from "./useSelectionStore";
import type { SelectionStore } from "./useSelectionStore";

/** The selection the canvas and panel edit: the photo workflow's, unless a feature provides its own. */
export const SelectionStoreContext = createContext<SelectionStore>(useSelectionStore);
export const useSelectionContext = () => useContext(SelectionStoreContext);
