import { useEffect, useState } from "react";
import { currentIsolation, useSelectionStore } from "../select";
import { layersKeyOf, loadSubjectLayers, subjectKeyOf } from "./subjectLayers";
import type { SubjectLayers } from "./subjectLayers";
import { useMotionStore } from "./useMotionStore";

/** Loads the current subject's layers once into the motion store, and prepares its motion. */
export function useSubjectLayers(): { layers: SubjectLayers | null; error: string | null } {
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const plateUrl = useSelectionStore(s => currentIsolation(s)?.plate.url);
  const key = image && mask && plateUrl ? layersKeyOf(image.url, mask.url, plateUrl) : null;
  const layers = useMotionStore(s => s.layersKey === key ? s.layers : null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!image || !mask || !plateUrl || !key || useMotionStore.getState().layersKey === key) return;
    let disposed = false;
    setError(null);
    loadSubjectLayers(image.url, plateUrl, mask.url).then(loaded => {
      if (disposed) return;
      useMotionStore.setState({ layers: loaded, layersKey: key });
      useMotionStore.getState().prepare(subjectKeyOf(image.id, mask.id), loaded.bounds, { width: loaded.width, height: loaded.height });
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : "Could not load the subject layers."); });
    return () => { disposed = true; };
  }, [image, mask, plateUrl, key]);

  return { layers, error };
}
