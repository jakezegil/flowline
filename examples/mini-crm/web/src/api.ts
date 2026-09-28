/**
 * The web app's data layer: typed calls to the CRM's `/api/*` routes, the Flowkit client for
 * `/flowkit/*`, and two small hooks (`useQuery`, `useUsers`) the pages share.
 *
 * @module
 */
import { createClient, type RunSummary } from "@flowkit/core/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Approval,
  Contact,
  Deal,
  DealStage,
  NewContact,
  OutboxMessage,
  User,
} from "../../server/src/crm-store";

export type { Approval, Contact, Deal, DealStage, NewContact, OutboxMessage, User };

/** Deal pipeline stages, in order (mirrors the server's `DEAL_STAGES`). */
export const DEAL_STAGES: readonly DealStage[] = ["lead", "qualified", "proposal", "won", "lost"];

/** The Flowkit editor API, served by the same server under `/flowkit`. */
export const flowkit = createClient({ baseUrl: "/flowkit" });

/** A failed `/api` request: `message` is the server's `{ error }` text. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    message: string,
    /** HTTP status. */
    readonly status: number,
    /** The parsed response body, when it was JSON. */
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** Where the dev server proxies `/api` (set by web/vite.config.ts; a build serves it itself). */
const API_TARGET: string | undefined = import.meta.env.DEV
  ? import.meta.env.VITE_CRM_API_TARGET
  : undefined;

/** The message for a server that doesn't answer, naming the address the app expects it at. */
export function unreachableMessage(target: string | undefined = API_TARGET): string {
  return target
    ? `Can't reach the CRM server. Is it running at ${target}?`
    : "Can't reach the CRM server. Is it running?";
}

const UNREACHABLE = unreachableMessage();

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { accept: "application/json" } };
  if (method !== "GET") {
    // Every mutation is JSON, bodyless ones included (the server requires the content type).
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(UNREACHABLE, 0, null);
  }
  // Through the Vite proxy a stopped server answers 502 (or 503/504) instead of failing the fetch.
  if (res.status >= 502 && res.status <= 504) throw new ApiError(UNREACHABLE, res.status, null);
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const message =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `${method} ${path} failed with ${res.status}`;
    throw new ApiError(message, res.status, parsed);
  }
  return parsed as T;
}

/** Response of `GET /api/demo`. */
export interface DemoInfo {
  tenantId: string;
  userId: string;
  /** Webhook paths by workflow ID. */
  webhooks: Record<string, string>;
}

/** The CRM's REST API. */
export const api = {
  listContacts: () => request<Contact[]>("GET", "/api/contacts"),
  createContact: (c: NewContact) => request<Contact>("POST", "/api/contacts", c),
  listDeals: () => request<Deal[]>("GET", "/api/deals"),
  updateDeal: (id: string, changes: Partial<Pick<Deal, "stage" | "amount" | "ownerId" | "name">>) =>
    request<{ deal: Deal; changes: string[] }>(
      "PATCH",
      `/api/deals/${encodeURIComponent(id)}`,
      changes,
    ),
  listUsers: () => request<User[]>("GET", "/api/users"),
  listOutbox: () => request<OutboxMessage[]>("GET", "/api/outbox"),
  listApprovals: () => request<Approval[]>("GET", "/api/approvals"),
  decide: (id: string, decision: "approved" | "rejected") =>
    request<{ approval: Approval }>("POST", `/api/approvals/${encodeURIComponent(id)}/decision`, {
      decision,
    }),
  demo: () => request<DemoInfo>("GET", "/api/demo"),
  reset: () => request<null>("POST", "/api/demo/reset"),
};

// ------------------------------------------------------------------ change notifications

type Topic = "contacts" | "deals" | "approvals" | "outbox" | "workflows" | "all";
const listeners = new Set<(topic: Topic) => void>();

/** Tell every mounted {@link useQuery} on `topic` (or everything, with `"all"`) to refetch. */
export function invalidate(topic: Topic): void {
  for (const l of listeners) l(topic);
}

/** State of a {@link useQuery}. */
export interface Query<T> {
  data: T | undefined;
  error: string | undefined;
  /** Refetch now. */
  reload(): void;
  /** Replace the data locally (optimistic updates). */
  setData(update: (prev: T | undefined) => T | undefined): void;
}

/**
 * Fetch `load()` on mount, when `topic` is invalidated, when the window regains focus, and every
 * `pollMs` if given. Keeps the
 * last data while refetching, so a poll never flashes a loading state.
 */
export function useQuery<T>(topic: Topic, load: () => Promise<T>, pollMs?: number): Query<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    loadRef.current().then(
      (d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(undefined);
      },
      (err: unknown) => {
        if (mine !== seq.current) return;
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }, []);

  useEffect(() => {
    reload();
    const onChange = (t: Topic) => {
      if (t === topic || t === "all") reload();
    };
    listeners.add(onChange);
    const timer = pollMs ? setInterval(reload, pollMs) : undefined;
    // Coming back to the tab (another tab may have changed things) refetches right away.
    window.addEventListener("focus", reload);
    return () => {
      window.removeEventListener("focus", reload);
      listeners.delete(onChange);
      if (timer) clearInterval(timer);
      seq.current++;
    };
  }, [topic, pollMs, reload]);

  // A local update wins over any fetch already in flight, which would otherwise land on top of it.
  const setLocal = useCallback((update: (prev: T | undefined) => T | undefined) => {
    seq.current++;
    setData(update);
  }, []);

  return { data, error, reload, setData: setLocal };
}

let usersPromise: Promise<User[]> | undefined;

/** The CRM's users (fetched once per page load and shared). */
export function useUsers(): { users: User[] | undefined; error: string | undefined } {
  const [users, setUsers] = useState<User[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    usersPromise ??= api.listUsers().catch((err: unknown) => {
      usersPromise = undefined;
      throw err;
    });
    usersPromise.then(
      (u) => active && setUsers(u),
      (err: unknown) => active && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      active = false;
    };
  }, []);
  return { users, error };
}

/** Looks up a workflow's name by ID (the ID itself until the list loads, or if it is unknown). */
export function useWorkflowName(): (id: string) => string {
  const { data } = useQuery("workflows", () => flowkit.listWorkflows());
  return useCallback((id: string) => data?.find((w) => w.id === id)?.name ?? id, [data]);
}

/**
 * Runs a CRM event started: those created since `since` by `event` whose trigger payload
 * satisfies `match`. The server awaits `engine.emit` before answering the mutation, so the runs
 * already exist when this is called.
 */
export async function runsStartedBy(
  event: string,
  since: number,
  match: (trigger: unknown) => boolean,
): Promise<RunSummary[]> {
  const recent = await flowkit.listRuns({ limit: 25 });
  const candidates = recent.filter(
    (r) => r.startedBy.kind === "event" && r.startedBy.event === event && r.createdAt >= since,
  );
  const details = await Promise.all(candidates.map((r) => flowkit.getRun(r.id)));
  return details.filter((d) => match(d.run.trigger)).map((d) => d.run);
}
