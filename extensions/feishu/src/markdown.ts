import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { MentionTarget } from "./mention-target.types.js";

/**
 * A fence opener may carry an info string and a closer may not, and both sit behind the
 * table's source prefix. Quote markers pass, and so do the three spaces of indentation a
 * fence is allowed: a fourth makes the line indented code rather than a fence, which is
 * where the shared scanner draws the line too. Matching nothing else keeps an inline
 * backtick run in ordinary prose, and a backtick line inside an indented code block, from
 * reading as a marker and suppressing a table that would have converted safely. A closer
 * keeps the carriage return of a CRLF source, since the line split is on the feed alone.
 */
type FeishuFenceLine = {
  /** One entry per container, outermost first: 0 for a quote, else the width a list item's content starts at. */
  containers: number[];
  column: number;
  indent: number;
  marker: string;
  info: string;
};

const FEISHU_TAB_STOP = 4;
const FEISHU_LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t])/u;
// `.` skips a carriage return, so the info string is matched as everything but the feed.
const FEISHU_FENCE_MARKER = /^(`{3,}|~{3,})([^\n]*)$/u;

/**
 * Read the containers a line sits in before its marker run: quotes and list items, each
 * naming the block the fence belongs to. A quote marker is repeated on every line of its block,
 * while a list marker carries on as indentation, so an item is kept as the width its content
 * starts at, measured from where the content of the container around it starts.
 */
function readFenceLine(line: string): FeishuFenceLine | undefined {
  let index = 0;
  // A tab advances to the next stop of four, so indentation is counted in columns rather
  // than characters: one tab is the four that make a line indented code.
  let column = 0;
  const containers: number[] = [];
  let indent = 0;
  // A quote or list marker takes the one column that follows it, so the content of the block
  // it opens starts there and the four that make indented code are counted from that column.
  // Every level is measured and the widest one settles the line, because four spaces before
  // the first marker are already indented code and a marker after them does not undo that.
  let markerColumn = 0;
  let start = 0;
  let listWidthPending = false;
  for (;;) {
    const columnStart = column;
    while (line[index] === " " || line[index] === "\t") {
      column =
        line[index] === "\t" ? column + FEISHU_TAB_STOP - (column % FEISHU_TAB_STOP) : column + 1;
      index += 1;
    }
    const gap = column - columnStart;
    indent = Math.max(indent, gap - markerColumn);
    if (markerColumn) {
      // The run after a marker is where its block's content starts. A list item takes up to four
      // of its spaces, and a longer run is indented code behind the one it keeps.
      const content =
        columnStart + (listWidthPending && gap >= 1 && gap <= 4 ? gap : Math.min(gap, 1));
      if (listWidthPending) {
        containers[containers.length - 1] = content - start;
      }
      start = content;
    }
    const rest = line.slice(index);
    if (rest.startsWith(">")) {
      containers.push(0);
      listWidthPending = false;
      index += 1;
      column += 1;
      markerColumn = 1;
      continue;
    }
    const list = FEISHU_LIST_MARKER.exec(rest);
    if (!list?.[0]) {
      break;
    }
    containers.push(1);
    listWidthPending = true;
    index += list[0].length;
    column += list[0].length;
    markerColumn = 1;
  }
  const marker = FEISHU_FENCE_MARKER.exec(line.slice(index));
  if (!marker?.[1]) {
    return undefined;
  }
  const info = marker[2] ?? "";
  // A backtick fence carries no backtick in its info string, which keeps an inline run in
  // ordinary prose from reading as a marker. A tilde fence carries anything, so a sample of
  // backticks inside one is content rather than a block of its own.
  if (marker[1].startsWith("`") && info.includes("`")) {
    return undefined;
  }
  return { containers, column, indent, marker: marker[1], info };
}

/**
 * Four spaces before anything else is indented code, not a fence, which is where the shared
 * scanner draws the line too, and a quote or list marker after them does not change that.
 * Inside a list item the same four spaces are where the item's content starts, so a fence
 * opened by the item's own marker line is closed by a marker at that column, which is why a
 * line that cannot open one can still close it.
 */
function opensFence(line: FeishuFenceLine): boolean {
  if (line.indent > 3) {
    return false;
  }
  return line.containers.length > 0 || line.column <= 3;
}

/**
 * Carry a line over the containers a fence was opened in. A quote repeats its marker, at most
 * three columns past where the content around it starts, and a list item is indented to the
 * width its content starts at, whatever marker it began with. What remains is the line's own
 * indentation and text. A line that cannot be carried has left a container, which ends the block
 * and the fence with it. A blank remainder carries a list item but not a quote.
 */
function carryContainers(
  containers: readonly number[],
  line: string,
): { indent: number; text: string } | undefined {
  let index = 0;
  let column = 0;
  let start = 0;
  const skipBlank = () => {
    while (line[index] === " " || line[index] === "\t") {
      column =
        line[index] === "\t" ? column + FEISHU_TAB_STOP - (column % FEISHU_TAB_STOP) : column + 1;
      index += 1;
    }
  };
  for (const width of containers) {
    skipBlank();
    if (width === 0) {
      if (line[index] !== ">" || column - start > 3) {
        return undefined;
      }
      index += 1;
      column += 1;
      start = column + (line[index] === " " || line[index] === "\t" ? 1 : 0);
    } else if (line.slice(index).trim() !== "") {
      if (column - start < width) {
        return undefined;
      }
      start += width;
    }
  }
  skipBlank();
  return { indent: column - start, text: line.slice(index) };
}

/**
 * Four spaces past the start of the block a line sits in are indented code on a closer the
 * same way they are on an opener, so a marker that far in is body text and the fence stays
 * open past it. The indentation is measured after the containers have been carried over the
 * line, which is why a closer with no marker of its own can sit far to the right.
 */
function closesFence(open: FeishuFenceLine, carried: { indent: number; text: string }): boolean {
  const marker = FEISHU_FENCE_MARKER.exec(carried.text);
  return (
    marker?.[1] !== undefined &&
    marker[1][0] === open.marker[0] &&
    marker[1].length >= open.marker.length &&
    (marker[2] ?? "").trim() === "" &&
    carried.indent <= 3
  );
}

/**
 * A chunk that opens a fence nothing closes renders worse than the table it replaced, so
 * the conversion only runs when every chunk closes what it opened. A run shorter than the
 * one that opened the block is body text, which is how a cell carrying its own backticks
 * survives inside the longer marker the conversion gave it. A marker behind other containers
 * is body text or a block of its own, and a line that leaves the fence's containers ends the
 * block unclosed, so neither closes it.
 */
function fencesBalance(chunk: string): boolean {
  let open: FeishuFenceLine | undefined;
  for (const text of chunk.split("\n")) {
    if (!open) {
      const fence = readFenceLine(text);
      open = fence && opensFence(fence) ? fence : undefined;
      continue;
    }
    const carried = carryContainers(open.containers, text);
    if (!carried) {
      return false;
    }
    if (closesFence(open, carried)) {
      open = undefined;
    }
  }
  return open === undefined;
}

function isFenceMarkerLine(line: string): boolean {
  return readFenceLine(line) !== undefined;
}

/**
 * `code` mode wraps each table in a fence, and the chunker closes and reopens that fence
 * at every boundary it cuts. It cannot do that for every shape. A cell's backticks
 * lengthen the marker, an indent widens the line the chunker has to fit twice, and a
 * quote prefix hides the marker from the fence scanner entirely, which no limit repairs.
 * Below a handful of characters the cut lands inside the marker and delivers backtick
 * fragments instead. Rather than model that budget, cut the converted text the way the
 * send will and ask three things of the pieces: each one stays inside the limit, each one
 * closes what it opened, and every marker arrives whole.
 */
export function fencesSurvive(converted: string, chunks: readonly string[]): boolean {
  if (!chunks.every(fencesBalance)) {
    return false;
  }
  const delivered = new Set(
    chunks.flatMap((chunk) => chunk.split("\n")).map((line) => line.trim()),
  );
  return converted
    .split("\n")
    .every((line) => !isFenceMarkerLine(line) || delivered.has(line.trim()));
}

export function chunkedFencesBalance(converted: string, limit: number, mode: ChunkMode): boolean {
  const chunks = chunkMarkdownTextWithMode(converted, limit, mode);
  return chunks.every((chunk) => chunk.length <= limit) && fencesSurvive(converted, chunks);
}

export type FeishuMarkdownNode = {
  type: string;
  depth?: number;
  identifier?: string;
  url?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: FeishuMarkdownNode[];
};

type FeishuPostMessageElement =
  | { tag: "at"; user_id: string; user_name?: string }
  | { tag: "md"; text: string };

const FEISHU_POST_MAX_BYTES = 30 * 1024;

/** One parser contract for Feishu message and document Markdown decisions. */
export function parseFeishuMarkdown(text: string): FeishuMarkdownNode {
  return fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }) as FeishuMarkdownNode;
}

export function visitFeishuMarkdown(
  root: FeishuMarkdownNode,
  visitor: (node: FeishuMarkdownNode) => void,
) {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    visitor(node);
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index -= 1) {
      const child = node.children?.[index];
      if (child) {
        pending.push(child);
      }
    }
  }
}

function buildFeishuPostMentionElements(mentions?: MentionTarget[]): FeishuPostMessageElement[] {
  if (!mentions?.length) {
    return [];
  }

  const elements: FeishuPostMessageElement[] = [];
  for (const mention of mentions) {
    const userId = mention.openId.trim();
    if (!userId) {
      continue;
    }
    const userName = mention.name.trim();
    elements.push({
      tag: "at",
      user_id: userId,
      ...(userName ? { user_name: userName } : {}),
    });
  }
  return elements;
}

export function buildFeishuPostMessageContent(params: {
  messageText: string;
  mentions?: MentionTarget[];
}): string {
  const content: FeishuPostMessageElement[] = [
    ...buildFeishuPostMentionElements(params.mentions),
    {
      tag: "md",
      text: params.messageText,
    },
  ];
  return JSON.stringify({
    zh_cn: {
      content: [content],
    },
  });
}

export function feishuPostWithinEnvelope(content: string): boolean {
  return Buffer.byteLength(content, "utf8") <= FEISHU_POST_MAX_BYTES;
}

export function assertFeishuPostWithinEnvelope(content: string, label: string): void {
  if (!feishuPostWithinEnvelope(content)) {
    throw new Error(`${label} exceeds the 30 KB rich-post API limit`);
  }
}

function collectSoftBreakOffsets(text: string): number[] {
  const root = parseFeishuMarkdown(text);
  const offsets: number[] = [];
  visitFeishuMarkdown(root, (node) => {
    if (node.type !== "text") {
      return;
    }

    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      return;
    }
    for (let offset = start; offset < end; offset += 1) {
      const char = text[offset];
      if (char === "\n") {
        if (text[offset - 1] !== "\r") {
          offsets.push(offset);
        }
        continue;
      }
      if (char === "\r") {
        offsets.push(offset);
        if (text[offset + 1] === "\n") {
          offset += 1;
        }
      }
    }
  });

  return offsets.toSorted((left, right) => left - right);
}

/**
 * Materialize CommonMark soft breaks for Feishu post `md` rendering.
 *
 * The parser identifies only soft breaks, then upgrades them to CommonMark
 * hard breaks. Structural line endings and code, HTML, definitions, setext
 * headings, and existing hard breaks retain their source bytes.
 */
export function materializeFeishuPostMarkdownSoftBreaks(text: string): string {
  if (!text.includes("\n") && !text.includes("\r")) {
    return text;
  }

  const softBreakOffsets = collectSoftBreakOffsets(text);
  if (softBreakOffsets.length === 0) {
    return text;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const offset of softBreakOffsets) {
    const lineEnding = text[offset] === "\r" ? (text[offset + 1] === "\n" ? "\r\n" : "\r") : "\n";
    parts.push(text.slice(cursor, offset), "  ", lineEnding);
    cursor = offset + lineEnding.length;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Keep every platform chunk independently valid Markdown, including fences. */
export function chunkFeishuMarkdown(text: string, limit: number): string[] {
  return chunkMarkdownTextWithMode(text, limit, "length");
}

function postContentBytes(messageText: string, mentions?: MentionTarget[]): number {
  return Buffer.byteLength(buildFeishuPostMessageContent({ messageText, mentions }), "utf8");
}

/**
 * Honor both configured character chunking and Feishu's serialized post envelope.
 * Markdown wrappers and first-chunk mentions count toward the byte budget.
 */
export type FeishuMarkdownChunkOptions = {
  text: string;
  limit: number;
  mode?: ChunkMode;
  firstChunkMentions?: MentionTarget[];
  chunkMentions?: MentionTarget[];
  initialChunks?: string[];
};

export function chunkFeishuPostMarkdown(params: FeishuMarkdownChunkOptions): string[] {
  return chunkFeishuMarkdownByEnvelope({
    ...params,
    contentBytes: (text, isFirst) =>
      postContentBytes(text, [
        ...(params.chunkMentions ?? []),
        ...(isFirst ? (params.firstChunkMentions ?? []) : []),
      ]),
  });
}

/**
 * The post chunker owns its own envelope, so the size question is already settled and only
 * the markers are in doubt. A quote-prefixed marker is invisible to the fence scanner, so
 * a converted blockquoted table cannot be closed and reopened at a cut and its two markers
 * land in different messages.
 */
export function postFencesSurvive(converted: string, params: FeishuMarkdownChunkOptions): boolean {
  return fencesSurvive(converted, chunkFeishuPostMarkdown(params));
}

/** Measure the actual transport envelope, including UTF-8, JSON escapes and fence wrappers. */
export function chunkFeishuMarkdownByEnvelope(
  params: FeishuMarkdownChunkOptions & {
    contentBytes: (text: string, isFirst: boolean) => number;
  },
): string[] {
  const { text } = params;
  if (!text) {
    return [];
  }

  const requestedLimit =
    Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : text.length;
  const initialChunks =
    params.initialChunks ??
    chunkMarkdownTextWithMode(text, requestedLimit, params.mode ?? "length");
  const output: string[] = [];
  for (const initialChunk of initialChunks) {
    if (params.contentBytes(initialChunk, output.length === 0) <= FEISHU_POST_MAX_BYTES) {
      output.push(initialChunk);
      continue;
    }

    let adaptiveLimit = Math.max(1, Math.min(requestedLimit, initialChunk.length));

    while (true) {
      const chunks = chunkMarkdownTextWithMode(
        initialChunk,
        adaptiveLimit,
        params.mode ?? "length",
      );
      let largestContentBytes = 0;
      let oversizedChunk: string | undefined;

      for (const [index, chunk] of chunks.entries()) {
        const contentBytes = params.contentBytes(chunk, output.length === 0 && index === 0);
        largestContentBytes = Math.max(largestContentBytes, contentBytes);
        if (contentBytes > FEISHU_POST_MAX_BYTES && oversizedChunk === undefined) {
          oversizedChunk = chunk;
        }
      }

      if (oversizedChunk === undefined) {
        output.push(...chunks);
        break;
      }
      if (adaptiveLimit === 1) {
        throw new Error("Feishu Markdown chunk exceeds the 30 KB API limit");
      }

      // Scale by the observed serialized size, then force progress for envelope
      // overhead or Markdown fence wrappers that do not shrink with source text.
      adaptiveLimit = Math.max(
        1,
        Math.min(
          adaptiveLimit - 1,
          Math.floor((adaptiveLimit * FEISHU_POST_MAX_BYTES) / largestContentBytes) - 1,
        ),
      );
    }
  }

  return output;
}
