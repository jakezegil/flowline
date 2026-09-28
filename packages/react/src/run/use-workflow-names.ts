import { useEffect, useRef, useState } from "react";
import { useFlowkit } from "../provider";

/**
 * Workflow display names by ID, from `client.listWorkflows()`: loaded once `ids` holds an ID it
 * doesn't know yet (and again for IDs that appear later, e.g. a workflow created since). An ID
 * the list doesn't have, or a failed load, stays unresolved.
 */
export function useWorkflowNames(ids: readonly string[], enabled: boolean): Map<string, string> {
  const { client } = useFlowkit();
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  /** IDs a load was started for: one that stays unknown doesn't trigger another load. */
  const asked = useRef(new Set<string>());
  const missing = enabled ? ids.filter((id) => !names.has(id) && !asked.current.has(id)) : [];
  const key = [...new Set(missing)].sort().join("\n");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (key === "") return;
    for (const id of key.split("\n")) asked.current.add(id);
    // Not cancelled when `key` changes: marking the IDs asked changes it right away.
    client.listWorkflows().then(
      (list) => mounted.current && setNames(new Map(list.map((w) => [w.id, w.name]))),
      () => {},
    );
  }, [client, key]);
  return names;
}
