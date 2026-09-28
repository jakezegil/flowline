/**
 * Finds and rewrites the step references inside JavaScript code (a Transform's `code`):
 * `steps.<id>`, `steps?.<id>`, `steps['<id>']`, `steps["<id>"]` and the same after `input.`. A
 * small tokenizer skips comments and the insides of strings, template text and regular
 * expressions, so only real accesses count. Pure and dependency-free.
 *
 * @module
 */

type Tok =
  | { kind: "ident"; text: string; start: number; end: number }
  | { kind: "str"; text: string; start: number; end: number }
  | { kind: "punct"; text: string; start: number; end: number }
  | { kind: "other"; text: string; start: number; end: number };

/** Keywords after which a `/` starts a regular expression rather than dividing. */
const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const IDENT_START = /[A-Za-z_$ -￿]/;
const IDENT_PART = /[\w$ -￿]/;

/** Tokens of `code` that matter for step references; string and template text is skipped. */
function tokenize(code: string): Tok[] {
  const out: Tok[] = [];
  /** Brace depths at which a template literal's `${` was opened. */
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  const n = code.length;

  const regexAllowed = (): boolean => {
    const prev = out.at(-1);
    if (!prev) return true;
    if (prev.kind === "ident") return REGEX_AFTER.has(prev.text);
    if (prev.kind === "str" || prev.kind === "other") return false;
    return !(prev.text === ")" || prev.text === "]" || prev.text === "}");
  };

  /** Reads template text from `i` (just after a backtick or a closing `}`) to `${` or the end. */
  const templateText = (): void => {
    while (i < n) {
      const c = code[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        i++;
        out.push({ kind: "other", text: "`", start: i - 1, end: i });
        return;
      } else if (c === "$" && code[i + 1] === "{") {
        i += 2;
        templates.push(depth);
        depth++;
        out.push({ kind: "punct", text: "${", start: i - 2, end: i });
        return;
      } else i++;
    }
  };

  while (i < n) {
    const c = code[i] as string;
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
    } else if (c === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
    } else if (c === "'" || c === '"') {
      const start = i++;
      let text = "";
      while (i < n && code[i] !== c && code[i] !== "\n") {
        if (code[i] === "\\") {
          text += code.slice(i, i + 2);
          i += 2;
        } else text += code[i++];
      }
      i++;
      out.push({ kind: "str", text, start, end: Math.min(i, n) });
    } else if (c === "`") {
      i++;
      templateText();
    } else if (c === "/" && regexAllowed()) {
      const start = i++;
      let inClass = false;
      while (i < n && code[i] !== "\n") {
        const d = code[i];
        if (d === "\\") i += 2;
        else if (d === "/" && !inClass) break;
        else {
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          i++;
        }
      }
      i++;
      while (i < n && IDENT_PART.test(code[i] as string)) i++;
      out.push({ kind: "other", text: "regex", start, end: i });
    } else if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_PART.test(code[i] as string)) i++;
      out.push({ kind: "ident", text: code.slice(start, i), start, end: i });
    } else if (/[0-9]/.test(c)) {
      const start = i;
      while (i < n && /[\w.]/.test(code[i] as string)) i++;
      out.push({ kind: "other", text: code.slice(start, i), start, end: i });
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "?" && code[i + 1] === "." && !/[0-9]/.test(code[i + 2] ?? "")) {
      out.push({ kind: "punct", text: "?.", start: i, end: i + 2 });
      i += 2;
    } else {
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (templates.at(-1) === depth) {
          templates.pop();
          i++;
          templateText();
          continue;
        }
      }
      out.push({ kind: "punct", text: c, start: i, end: i + 1 });
      i++;
    }
  }
  return out;
}

/** One `steps.<id>` access found in code: where its ID is written and how. */
interface CodeStepRef {
  stepId: string;
  /** The access after `steps`: from its `.`/`?.`/`[` to the end of the ID (or closing `]`). */
  start: number;
  end: number;
  optional: boolean;
}

/**
 * The step accesses in `code`, and whether it also uses `steps` in a way that can't be read
 * statically (`steps[key]`, `const { a } = steps`, passing `steps` along).
 */
function scan(code: string): { refs: CodeStepRef[]; opaque: boolean } {
  const toks = tokenize(code);
  const refs: CodeStepRef[] = [];
  let opaque = false;
  const text = (k: number) => toks[k]?.text;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Tok;
    if (t.kind !== "ident" || t.text !== "steps") continue;
    const before = text(k - 1);
    if (before === "." || before === "?.") {
      // Only `input.steps` is the scope's `steps`; `other.steps` is something else.
      if (text(k - 2) !== "input" || text(k - 3) === "." || text(k - 3) === "?.") continue;
    }
    let j = k + 1;
    const optional = text(j) === "?.";
    if (optional) j++;
    const at = toks[j];
    const next = toks[j + 1];
    if (!optional && at?.text === "." && next?.kind === "ident") {
      refs.push({ stepId: next.text, start: at.start, end: next.end, optional });
    } else if (optional && at?.kind === "ident") {
      refs.push({ stepId: at.text, start: (toks[k + 1] as Tok).start, end: at.end, optional });
    } else if (at?.text === "[" && next?.kind === "str" && text(j + 2) === "]") {
      const close = toks[j + 2] as Tok;
      refs.push({
        stepId: next.text,
        start: (toks[k + 1] as Tok).start,
        end: close.end,
        optional,
      });
    } else {
      opaque = true;
    }
  }
  return { refs, opaque };
}

const JS_IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Rewrites the step accesses in `code` whose ID is a key of `idMap` to the mapped ID, keeping
 * the access's style (`steps.a` → `steps.b`, `steps['a']` → `steps['b']`), and returns the new
 * code (the same string when nothing changed).
 */
export function rewriteCodeStepRefs(code: string, idMap: ReadonlyMap<string, string>): string {
  const { refs } = scan(code);
  let out = code;
  for (const ref of [...refs].reverse()) {
    const to = idMap.get(ref.stepId);
    if (to === undefined) continue;
    const written = code.slice(ref.start, ref.end);
    let replacement: string;
    if (written.endsWith("]")) {
      const quote = written.includes("'") ? "'" : '"';
      replacement = `${ref.optional ? "?." : ""}[${quote}${to}${quote}]`;
    } else if (JS_IDENT.test(to)) {
      replacement = `${ref.optional ? "?." : "."}${to}`;
    } else {
      replacement = `${ref.optional ? "?." : ""}["${to}"]`;
    }
    out = out.slice(0, ref.start) + replacement + out.slice(ref.end);
  }
  return out;
}

/**
 * Whether `code` might read step `stepId` in a way {@link rewriteCodeStepRefs} can't follow: it
 * uses `steps` dynamically (`steps[key]`, destructuring, passing it along) and the ID also appears
 * in the code as a name or a string. Renaming that step would silently break the code.
 */
export function codeReadsStepOpaquely(code: string, stepId: string): boolean {
  const { opaque } = scan(code);
  if (!opaque) return false;
  return tokenize(code).some((t) => (t.kind === "ident" || t.kind === "str") && t.text === stepId);
}
