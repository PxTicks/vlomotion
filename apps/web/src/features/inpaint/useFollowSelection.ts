import { createSelectionStore } from "../select/useSelectionStore";

/** The subjects selected on the video's first frame for the mask to follow. Its image is that frame, as the tracker sees it. */
export const useFollowSelection = createSelectionStore();
export const resetFollowSelection = () => useFollowSelection.setState(useFollowSelection.getInitialState(), true);
