import { useEffect, useRef, useState } from "react";
import { useFlowline } from "../provider";

/** How long loaded names are trusted before the next `ids` change reloads them (renames). */
export const WORKFLOW_NAMES_MAX_AGE_MS = 60_000;

/**
 * Workflow display names by ID, from `client.listWorkflows()`: loaded once `ids` holds an ID it
 * doesn't know yet (and again for IDs that appear later, e.g. a workflow created since). A new
 * `ids` array (e.g. the run list's next poll) also reloads them once they are older than
 * `maxAgeMs`, so renamed workflows catch up. An ID the list doesn't have, or a failed load, stays
 * unresolved.
 */
export function useWorkflowNames(
  ids: readonly string[],
  enabled: boolean,
  maxAgeMs = WORKFLOW_NAMES_MAX_AGE_MS,
): Map<string, string> {
  const { client } = useFlowline();
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  /** IDs a load was started for: one that stays unknown doesn't trigger another load. */
  const asked = useRef(new Set<string>());
  /** When the last load started (0: never). */
  const loadedAt = useRef(0);
  const missing = enabled ? ids.filter((id) => !names.has(id) && !asked.current.has(id)) : [];
  const key = [...new Set(missing)].sort().join("\n");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // `ids` identity is the refresh signal (a new poll), besides the unknown IDs in `key`.
  useEffect(() => {
    if (!enabled || ids.length === 0) return;
    const stale = loadedAt.current > 0 && Date.now() - loadedAt.current >= maxAgeMs;
    if (key === "" && !stale) return;
    for (const id of key === "" ? [] : key.split("\n")) asked.current.add(id);
    loadedAt.current = Date.now();
    // Not cancelled when `key` changes: marking the IDs asked changes it right away.
    client.listWorkflows().then(
      (list) => mounted.current && setNames(new Map(list.map((w) => [w.id, w.name]))),
      () => {},
    );
  }, [client, key, ids, enabled, maxAgeMs]);
  return names;
}
