import type { ReactNode } from "react";

// Renders the small Markdown subset agents write: paragraphs, bullet and
// numbered lists, fenced code, headings, **bold** and `code`. Every node is
// React text, so nothing in a message is ever parsed as HTML.
type Block =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly string[];
    };

const FENCE = /^\s*```/u;
const BULLET = /^\s*[-*+]\s+/u;
const NUMBERED = /^\s*\d+[.)]\s+/u;
const HEADING = /^\s*#{1,6}\s+/u;
const INLINE = /(?<token>\*\*[^*\n]+\*\*|`[^`\n]+`)/u;

const listMarker = (line: string): boolean | null => {
  if (BULLET.test(line)) {
    return false;
  }
  return NUMBERED.test(line) ? true : null;
};

const parseBlocks = (text: string): Block[] => {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const ordered = listMarker(line);
    if (ordered !== null) {
      flush();
      const previous = blocks.at(-1);
      const item = line.replace(ordered ? NUMBERED : BULLET, "");
      if (previous?.kind === "list" && previous.ordered === ordered) {
        blocks[blocks.length - 1] = {
          ...previous,
          items: [...previous.items, item],
        };
      } else {
        blocks.push({ items: [item], kind: "list", ordered });
      }
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      blocks.push({ kind: "heading", text: line.replace(HEADING, "") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
};

// Keys from content, with a count for repeats, so equal lines stay distinct.
const keyed = <T,>(
  items: readonly T[],
  label: (item: T) => string
): { item: T; key: string }[] => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = label(item);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { item, key: `${base}:${count}` };
  });
};

const inline = (text: string): ReactNode[] =>
  keyed(text.split(INLINE), (part) => part).map(({ item: part, key }) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return part;
  });

const renderBlock = (block: Block, key: string) => {
  if (block.kind === "code") {
    return (
      <pre key={key}>
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "heading") {
    return (
      <p className="message-heading" key={key}>
        {inline(block.text)}
      </p>
    );
  }
  if (block.kind === "list") {
    const items = keyed(block.items, (item) => item).map(
      ({ item, key: id }) => <li key={id}>{inline(item)}</li>
    );
    return block.ordered ? (
      <ol key={key}>{items}</ol>
    ) : (
      <ul key={key}>{items}</ul>
    );
  }
  return <p key={key}>{inline(block.text)}</p>;
};

// Blocks render as direct children of the message so it stays one flow.
export const MessageText = ({ text }: { text: string }) => (
  <>
    {keyed(parseBlocks(text), (block) =>
      block.kind === "list"
        ? `list:${block.items.join("\n")}`
        : `${block.kind}:${block.text}`
    ).map(({ item, key }) => renderBlock(item, key))}
  </>
);
