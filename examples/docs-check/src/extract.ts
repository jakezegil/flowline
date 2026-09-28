/**
 * Pulls TypeScript code blocks out of Markdown. A block is checked when its fence names a file:
 *
 *     ```ts file=flowkit/nodes.ts
 *
 * The blocks of one document become the files of one project (plus that project's stubs), so
 * they can import each other exactly as the prose describes. `nocheck` opts a block out.
 */

/** A checked code block. */
export interface DocBlock {
  /** Project-relative path from the `file=` annotation. */
  file: string;
  /** The block's source, verbatim. */
  code: string;
  /** 1-based line of the opening fence. */
  line: number;
}

/** The checked blocks of `markdown`, and the fence lines of ts/tsx blocks with no annotation. */
export function extractBlocks(markdown: string): { blocks: DocBlock[]; unannotated: number[] } {
  const blocks: DocBlock[] = [];
  const unannotated: number[] = [];
  const fence = /^```(\w+)([^\n]*)\n([\s\S]*?)^```/gm;
  for (const m of markdown.matchAll(fence)) {
    const [, lang = "", info = "", code = ""] = m;
    if (lang !== "ts" && lang !== "tsx") continue;
    const line = markdown.slice(0, m.index).split("\n").length;
    const attrs = info.trim().split(/\s+/);
    if (attrs.includes("nocheck")) continue;
    const file = attrs.find((a) => a.startsWith("file="))?.slice("file=".length);
    if (file) blocks.push({ file, code, line });
    else unannotated.push(line);
  }
  return { blocks, unannotated };
}
