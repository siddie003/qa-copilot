import type { Link, Nodes, Paragraph, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { BlockCollector, type ExtractionResult } from "./blocks";

function toText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string" && node.type !== "html") return node.value;
  if (node.type === "break") return " ";
  if (node.type === "image") return node.alt ?? "";
  if ("children" in node) return (node.children as Nodes[]).map(toText).join("");
  return "";
}

const lineOf = (n: { position?: { start: { line: number } } }) => n.position?.start.line;

/** A paragraph that consists of one link and nothing else (a standalone link or button). */
function soleLink(p: Paragraph): Link | null {
  const meaningful = p.children.filter((c) => !(c.type === "text" && !c.value.trim()));
  return meaningful.length === 1 && meaningful[0]!.type === "link" ? meaningful[0] : null;
}

/**
 * Markdown via mdast: headings, paragraphs, list items (nested lists flattened), block quotes,
 * table cells; standalone links become link blocks; `CTA:` lines become CTAs; page markers
 * (`Page: About`, `<!-- page: /about -->`) set the page for the following blocks. Code blocks
 * and raw HTML are not website copy and are skipped.
 */
export function extractMarkdown(
  input: string,
  opts: { maxBlocks?: number } = {},
): ExtractionResult {
  const c = new BlockCollector({ maxBlocks: opts.maxBlocks });
  const tree: Root = fromMarkdown(input.replace(/^\uFEFF/, ""));

  const visit = (node: RootContent) => {
    switch (node.type) {
      case "heading":
        c.add("heading", toText(node), { level: node.depth, line: lineOf(node) });
        return;
      case "paragraph": {
        const text = toText(node);
        const link = soleLink(node);
        const firstLink = node.children.find((x): x is Link => x.type === "link");
        c.addText(text, {
          line: lineOf(node),
          href: link?.url ?? firstLink?.url ?? null,
          linkOnly: Boolean(link),
        });
        return;
      }
      case "list":
        for (const item of node.children) {
          const own = item.children.filter((x) => x.type !== "list");
          const text = own.map((x) => toText(x as Nodes)).join(" ");
          if (!c.marker(text)) c.add("list_item", text, { line: lineOf(item) });
          for (const nested of item.children.filter((x) => x.type === "list")) visit(nested);
        }
        return;
      case "blockquote":
        node.children.forEach(visit);
        return;
      case "table":
        for (const row of node.children)
          for (const cell of row.children) c.addText(toText(cell), { line: lineOf(cell) });
        return;
      case "html":
        c.marker(node.value.trim());
        return;
      default:
        return; // code, thematic breaks, definitions: not website copy
    }
  };
  tree.children.forEach(visit);
  return c.result();
}
