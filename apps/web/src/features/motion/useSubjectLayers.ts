import { useEffect, useMemo, useState } from "react";
import { currentIsolation, useSelectionStore } from "../select";
import { layersKeyOf, loadSubjectLayers, subjectKeyOf } from "./subjectLayers";
import type { SubjectLayers } from "./subjectLayers";
import { useMotionStore } from "./useMotionStore";

/** Loads the shared background and an independent cutout for each included subject. */
export function useSubjectLayers(): { layers: SubjectLayers | null; error: string | null } {
  const image = useSelectionStore(s => s.image);
  const mask = useSelectionStore(s => s.mask);
  const plateUrl = useSelectionStore(s => currentIsolation(s)?.plate.url);
  const candidates = useSelectionStore(s => s.candidates);
  const selectedIds = useSelectionStore(s => s.selectedIds);
  const labels = useSelectionStore(s => s.labels);
  const inputs = useMemo(() => candidates.filter(candidate => selectedIds.includes(candidate.id)).map((candidate, index) =>
    ({ id: candidate.id, name: labels[candidate.id] ?? `Subject ${index + 1}`, url: candidate.url })), [candidates, selectedIds, labels]);
  const layersKey = image && mask && plateUrl ? layersKeyOf(image.url, mask.url, plateUrl) : null;
  const sceneKey = layersKey ? JSON.stringify([layersKey, inputs]) : null;
  const layers = useMotionStore(s => s.sceneKey === sceneKey ? s.layers : null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!image || !mask || !plateUrl || !layersKey || !sceneKey || useMotionStore.getState().sceneKey === sceneKey) return;
    let disposed = false;
    setError(null);
    async function load() {
      const shared = await loadSubjectLayers(image!.url, plateUrl!, mask!.url);
      const subjects = inputs.length ? await Promise.all(inputs.map(async input => ({ id: input.id, name: input.name,
        layers: inputs.length === 1 ? shared : await loadSubjectLayers(image!.url, plateUrl!, input.url, shared) })))
        : [{ id: mask!.id, name: "Subject", layers: shared }];
      if (!disposed) useMotionStore.getState().prepareSubjects(subjectKeyOf(image!.id, mask!.id), layersKey!, sceneKey!, shared, subjects);
    }
    void load().catch(error => { if (!disposed) setError(error instanceof Error ? error.message : "Could not load the subject layers."); });
    return () => { disposed = true; };
  }, [image, mask, plateUrl, layersKey, sceneKey, inputs]);

  return { layers, error };
}
