/**
 * Design-time checks that catch what would only fail (or silently misbehave) at run time: email
 * fields that can't hold one address, outbound URLs the engine's network policy blocks, and steps
 * after a Stop that can never run. Pure and isomorphic, used by the validator and the editor.
 *
 * @module
 */
import { branchesFor, configValueAt } from "./json-schema";
import { parseTemplate } from "./refs";
import type { ValidationContext } from "./scope";
import type { Manifest, NodeManifest, Step, WorkflowDoc } from "./types";

/** One address, `local@domain.tld`, with no spaces, commas or angle brackets. */
const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()".]+$/;

/**
 * Why a value of an email-format field (`format: "email"`) can't be one email address, or
 * `undefined` when it looks fine. A literal must look like an address. A template must not mix
 * its references with words (text with spaces), which is how an address gets glued to the next
 * field's text (`dev@acme.testEnterprise lead approved`).
 */
export function emailProblem(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" || EMAIL.test(value.trim())
      ? undefined
      : "isn't a valid email address";
  }
  if (typeof value === "object" && value !== null && "$tpl" in value) {
    const tpl = (value as { $tpl: unknown }).$tpl;
    if (typeof tpl !== "string") return undefined;
    const text = parseTemplate(tpl)
      .flatMap((p) => ("text" in p ? [p.text] : []))
      .join("");
    if (/\s/.test(text)) {
      const words = text.trim();
      return words === ""
        ? "should be one email address, but it joins several values with spaces"
        : `should be one email address, but its references are mixed with other text ("${words}")`;
    }
  }
  return undefined;
}

/**
 * The host of a URL whose scheme and host are written out literally, lower-cased and without
 * IPv6 brackets. With `complete: false` (the text before a template's first reference) the host
 * must be followed by `/`, `:`, `?` or `#`, since a reference right after it could extend it.
 */
export function literalUrlHost(text: string, complete = true): string | undefined {
  const m = /^\s*[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#\s]*@)?(\[[^\]]*\]|[^/?#:[\]\s]+)(.?)/i.exec(text);
  if (!m) return undefined;
  const host = (m[1] ?? "").toLowerCase();
  const next = m[2] ?? "";
  if (!complete && next === "") return undefined;
  return host.startsWith("[") ? host.slice(1, -1) : host;
}

function ipv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const nums = parts.map(Number);
  return nums.every((n) => n <= 255) ? nums : undefined;
}

/**
 * Whether a host, as written, is loopback, private, link-local or otherwise not public:
 * `localhost` (and `*.localhost`), `0.0.0.0`, `10/8`, `100.64/10`, `127/8`, `169.254/16`,
 * `172.16/12`, `192.168/16`, `::`, `::1`, `fc00::/7`, `fe80::/10` and IPv4-mapped forms of these.
 * Names that only resolve to private addresses can't be known without DNS and count as public.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = ipv4(h);
  if (v4) {
    const [a = 0, b = 0] = v4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped?.[1]) return isPrivateHost(mapped[1]);
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}

/**
 * Why the engine's network policy would block a request to the URL value of an `outboundUrl`
 * field, or `undefined`. Only literal hosts are judged: a literal URL, or a template whose host
 * is written out before its first reference.
 */
export function blockedUrlProblem(
  value: unknown,
  network: ValidationContext["network"],
): string | undefined {
  let host: string | undefined;
  if (typeof value === "string") host = literalUrlHost(value);
  else if (typeof value === "object" && value !== null && "$tpl" in value) {
    const tpl = (value as { $tpl: unknown }).$tpl;
    if (typeof tpl === "string") {
      const [first] = parseTemplate(tpl);
      if (first && "text" in first) host = literalUrlHost(first.text, false);
    }
  }
  if (!host) return undefined;
  if (network?.allowPrivateNetworks !== true && isPrivateHost(host)) {
    return `points to ${host}, a private or loopback address. The engine blocks these to protect your network, so the request will fail when the workflow runs. Use a public address, or allow private networks in the engine's settings`;
  }
  const allow = network?.allowHosts;
  if (allow && !allow.some((a) => a.toLowerCase() === host)) {
    return `points to ${host}, which isn't one of the hosts the engine may call, so the request will fail when the workflow runs`;
  }
  return undefined;
}

/** A step that ends the run on every path, and the steps after it that therefore never run. */
export interface UnreachableGroup {
  /** The step every path through which ends the run (a Stop, or a block whose branches all do). */
  endsAt: string;
  /** IDs of the steps after it (with their subtrees), in document order. */
  stepIds: string[];
}

/** Whether running `step` always ends the run (it can't continue to the next step). */
function alwaysEnds(step: Step, nodes: Map<string, NodeManifest>): boolean {
  if (step.disabled) return false;
  const m = nodes.get(step.type);
  if (!m) return false;
  if (m.endsRun) return true;
  const spec = m.branches;
  // A loop may run zero times; a step without branches continues.
  if (spec.kind !== "static" && spec.kind !== "fromConfig") return false;
  if (spec.kind === "fromConfig" && !Array.isArray(configValueAt(step.config, spec.configPath)))
    return false;
  const declared = branchesFor(m, step);
  return (
    declared.length > 0 &&
    declared.every((b) => endIndex(step.branches?.[b.id] ?? [], nodes) !== -1)
  );
}

function endIndex(list: readonly Step[], nodes: Map<string, NodeManifest>): number {
  return list.findIndex((s) => alwaysEnds(s, nodes));
}

function collectIds(steps: readonly Step[], out: string[]): void {
  for (const s of steps) {
    out.push(s.id);
    for (const list of Object.values(s.branches ?? {})) collectIds(list, out);
  }
}

/**
 * The steps that can never run because an earlier step always ends the run: those after a Stop
 * (any node with `endsRun`) in the same list, and those after a block whose every declared branch
 * ends the run. Loops may run zero times, so they never end the run for this purpose; disabled
 * steps are skipped at run time, so they never do either.
 */
export function unreachableSteps(doc: WorkflowDoc, manifest: Manifest): UnreachableGroup[] {
  const nodes = new Map(manifest.nodes.map((n) => [n.type, n]));
  const groups: UnreachableGroup[] = [];
  const walk = (list: readonly Step[]) => {
    const end = endIndex(list, nodes);
    const reachable = end === -1 ? list : list.slice(0, end + 1);
    for (const s of reachable) for (const inner of Object.values(s.branches ?? {})) walk(inner);
    const endStep = list[end];
    if (endStep && end < list.length - 1) {
      const stepIds: string[] = [];
      collectIds(list.slice(end + 1), stepIds);
      groups.push({ endsAt: endStep.id, stepIds });
    }
  };
  walk(doc.steps);
  return groups;
}
