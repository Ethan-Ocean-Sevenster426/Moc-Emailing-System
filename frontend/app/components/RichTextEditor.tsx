"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Filament-style rich editor for the email body — same toolbar as Beacon's
 * RichEditor (Filament v4 defaults), using Filament's exact icons, plus:
 * a Link dialog (URL + open in new tab) and a floating table toolbar
 * (add/delete rows & columns, merge/split, header toggles, delete) that
 * appears when the caret is inside a table — like Beacon's floatingToolbars.
 */
interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  readOnly?: boolean;
  /** Receives the contenteditable element, e.g. for inserting merge variables at the caret. */
  editorRef?: React.MutableRefObject<HTMLDivElement | null>;
  /** Typing-surface minimum height (Beacon: 20rem in the touchpoint editor, compact in the template modal). */
  minHeight?: string;
}

/* Filament's toolbar icons, verbatim (heroicons/tabler as shipped with fi-fo-rich-editor) */
const I = {
  bold: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4 3a1 1 0 0 1 1-1h6a4.5 4.5 0 0 1 3.274 7.587A4.75 4.75 0 0 1 11.25 18H5a1 1 0 0 1-1-1V3Zm2.5 5.5v-4H11a2 2 0 1 1 0 4H6.5Zm0 2.5v4.5h4.75a2.25 2.25 0 0 0 0-4.5H6.5Z" clipRule="evenodd" /></svg>,
  italic: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8 2.75A.75.75 0 0 1 8.75 2h7.5a.75.75 0 0 1 0 1.5h-3.215l-4.483 13h2.698a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5h3.215l4.483-13H8.75A.75.75 0 0 1 8 2.75Z" clipRule="evenodd" /></svg>,
  underline: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.75 2a.75.75 0 0 1 .75.75V9a4.5 4.5 0 1 0 9 0V2.75a.75.75 0 0 1 1.5 0V9A6 6 0 0 1 4 9V2.75A.75.75 0 0 1 4.75 2ZM2 17.25a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" /></svg>,
  strike: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M11.617 3.963c-1.186-.318-2.418-.323-3.416.015-.992.336-1.49.91-1.642 1.476-.152.566-.007 1.313.684 2.1.528.6 1.273 1.1 2.128 1.446h7.879a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5h3.813a5.976 5.976 0 0 1-.447-.456C5.18 7.479 4.798 6.231 5.11 5.066c.312-1.164 1.268-2.055 2.61-2.509 1.336-.451 2.877-.42 4.286-.043.856.23 1.684.592 2.409 1.074a.75.75 0 1 1-.83 1.25 6.723 6.723 0 0 0-1.968-.875Zm1.909 8.123a.75.75 0 0 1 1.015.309c.53.99.607 2.062.18 3.01-.421.94-1.289 1.648-2.441 2.038-1.336.452-2.877.42-4.286.043-1.409-.377-2.759-1.121-3.69-2.18a.75.75 0 1 1 1.127-.99c.696.791 1.765 1.403 2.952 1.721 1.186.318 2.418.323 3.416-.015.853-.288 1.34-.756 1.555-1.232.21-.467.205-1.049-.136-1.69a.75.75 0 0 1 .308-1.014Z" clipRule="evenodd" /></svg>,
  subscript: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 7l8 10m-8 0l8 -10" /><path d="M21 20h-4l3.5 -4a1.73 1.73 0 0 0 -3.5 -2" /></svg>,
  superscript: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 7l8 10m-8 0l8 -10" /><path d="M21 11h-4l3.5 -4a1.73 1.73 0 0 0 -3.5 -2" /></svg>,
  link: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0 .225 5.865.75.75 0 0 0 .977-1.138 2.5 2.5 0 0 1-.142-3.667l3-3Z" /><path d="M11.603 7.963a.75.75 0 0 0-.977 1.138 2.5 2.5 0 0 1 .142 3.667l-3 3a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 1 0 5.656 5.656l3-3a4 4 0 0 0-.225-5.865Z" /></svg>,
  h2: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 12a2 2 0 1 1 4 0c0 .591 -.417 1.318 -.816 1.858l-3.184 4.143l4 0" /><path d="M4 6v12" /><path d="M12 6v12" /><path d="M11 18h2" /><path d="M3 18h2" /><path d="M4 12h8" /><path d="M3 6h2" /><path d="M11 6h2" /></svg>,
  h3: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 14a2 2 0 1 0 -2 -2" /><path d="M17 16a2 2 0 1 0 2 -2" /><path d="M4 6v12" /><path d="M12 6v12" /><path d="M11 18h2" /><path d="M3 18h2" /><path d="M4 12h8" /><path d="M3 6h2" /><path d="M11 6h2" /></svg>,
  alignStart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l16 0" /><path d="M4 12l10 0" /><path d="M4 18l14 0" /></svg>,
  alignCenter: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l16 0" /><path d="M8 12l8 0" /><path d="M6 18l12 0" /></svg>,
  alignEnd: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l16 0" /><path d="M10 12l10 0" /><path d="M6 18l14 0" /></svg>,
  blockquote: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 2c-2.236 0-4.43.18-6.57.524C1.993 2.755 1 4.014 1 5.426v5.148c0 1.413.993 2.67 2.43 2.902 1.168.188 2.352.327 3.55.414.28.02.521.18.642.413l1.713 3.293a.75.75 0 0 0 1.33 0l1.713-3.293a.783.783 0 0 1 .642-.413 41.102 41.102 0 0 0 3.55-.414c1.437-.231 2.43-1.49 2.43-2.902V5.426c0-1.413-.993-2.67-2.43-2.902A41.289 41.289 0 0 0 10 2ZM6.75 6a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Zm0 2.5a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5h-3.5Z" clipRule="evenodd" /></svg>,
  codeBlock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h2.5a3 3 0 0 1 3 3v10a3 3 0 0 1 -3 3h-10a3 3 0 0 1 -3 -3v-5" /><path d="M6 5l-2 2l2 2" /><path d="M10 9l2 -2l-2 -2" /></svg>,
  bulletList: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M6 4.75A.75.75 0 0 1 6.75 4h10.5a.75.75 0 0 1 0 1.5H6.75A.75.75 0 0 1 6 4.75ZM6 10a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H6.75A.75.75 0 0 1 6 10Zm0 5.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H6.75a.75.75 0 0 1-.75-.75ZM1.99 4.75a1 1 0 0 1 1-1H3a1 1 0 0 1 1 1v.01a1 1 0 0 1-1 1h-.01a1 1 0 0 1-1-1v-.01ZM1.99 15.25a1 1 0 0 1 1-1H3a1 1 0 0 1 1 1v.01a1 1 0 0 1-1 1h-.01a1 1 0 0 1-1-1v-.01ZM1.99 10a1 1 0 0 1 1-1H3a1 1 0 0 1 1 1v.01a1 1 0 0 1-1 1h-.01a1 1 0 0 1-1-1V10Z" clipRule="evenodd" /></svg>,
  orderedList: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 1.25a.75.75 0 0 0 0 1.5h.25v2.5a.75.75 0 0 0 1.5 0V2A.75.75 0 0 0 4 1.25H3ZM2.97 8.654a3.5 3.5 0 0 1 1.524-.12.034.034 0 0 1-.012.012L2.415 9.579A.75.75 0 0 0 2 10.25v1c0 .414.336.75.75.75h2.5a.75.75 0 0 0 0-1.5H3.927l1.225-.613c.52-.26.848-.79.848-1.371 0-.647-.429-1.327-1.193-1.451a5.03 5.03 0 0 0-2.277.155.75.75 0 0 0 .44 1.434ZM7.75 3a.75.75 0 0 0 0 1.5h9.5a.75.75 0 0 0 0-1.5h-9.5ZM7.75 9.25a.75.75 0 0 0 0 1.5h9.5a.75.75 0 0 0 0-1.5h-9.5ZM7.75 15.5a.75.75 0 0 0 0 1.5h9.5a.75.75 0 0 0 0-1.5h-9.5ZM2.625 13.875a.75.75 0 0 0 0 1.5h1.5a.125.125 0 0 1 0 .25H3.5a.75.75 0 0 0 0 1.5h.625a.125.125 0 0 1 0 .25h-1.5a.75.75 0 0 0 0 1.5h1.5a1.625 1.625 0 0 0 1.37-2.5 1.625 1.625 0 0 0-1.37-2.5h-1.5Z" /></svg>,
  table: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z" /><path d="M3 10h18" /><path d="M10 3v18" /></svg>,
  attachFiles: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.242Z" clipRule="evenodd" /></svg>,
  undo: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clipRule="evenodd" /></svg>,
  redo: <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M12.207 2.232a.75.75 0 0 0 .025 1.06l4.146 3.958H6.375a5.375 5.375 0 0 0 0 10.75H9.25a.75.75 0 0 0 0-1.5H6.375a3.875 3.875 0 0 1 0-7.75h10.003l-4.146 3.957a.75.75 0 0 0 1.036 1.085l5.5-5.25a.75.75 0 0 0 0-1.085l-5.5-5.25a.75.75 0 0 0-1.06.025Z" clipRule="evenodd" /></svg>,
};

const TH_STYLE = "border:1px solid #d1d5db;padding:4px 8px;background:#f9fafb";
const TD_STYLE = "border:1px solid #d1d5db;padding:4px 8px";

export default function RichTextEditor({ value, onChange, readOnly = false, editorRef, minHeight = "20rem" }: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({ justifyLeft: true });

  // Link dialog
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkNewTab, setLinkNewTab] = useState(false);
  const [linkExisting, setLinkExisting] = useState(false);

  // Floating table toolbar
  const [tablePos, setTablePos] = useState<{ top: number; left: number } | null>(null);
  const activeCellRef = useRef<HTMLTableCellElement | null>(null);

  // Sync external value changes (template fills, opening another email) without
  // disturbing the caret while typing (value === innerHTML → no-op).
  useEffect(() => {
    const el = ref.current;
    if (el && (value || "") !== el.innerHTML) el.innerHTML = value || "";
  }, [value]);

  const commit = useCallback(() => {
    if (ref.current) onChange(ref.current.innerHTML);
  }, [onChange]);

  // Track active formats + whether the caret sits inside a table
  useEffect(() => {
    function update() {
      const el = ref.current;
      const sel = window.getSelection();
      if (!el || !sel || !el.contains(sel.anchorNode)) return;
      const blockTag = (document.queryCommandValue("formatBlock") || "").toLowerCase();
      const center = document.queryCommandState("justifyCenter");
      const right = document.queryCommandState("justifyRight");
      setActive({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        strikeThrough: document.queryCommandState("strikeThrough"),
        subscript: document.queryCommandState("subscript"),
        superscript: document.queryCommandState("superscript"),
        justifyCenter: center,
        justifyRight: right,
        justifyLeft: !center && !right,
        insertUnorderedList: document.queryCommandState("insertUnorderedList"),
        insertOrderedList: document.queryCommandState("insertOrderedList"),
        h2: blockTag === "h2",
        h3: blockTag === "h3",
        blockquote: blockTag === "blockquote",
        pre: blockTag === "pre",
      });

      // Floating table toolbar position — shown while the caret is in a cell
      const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      const cell = (node?.closest?.("td,th") as HTMLTableCellElement | null) ?? null;
      activeCellRef.current = cell && el.contains(cell) ? cell : null;
      const table = activeCellRef.current?.closest("table") ?? null;
      if (table && surfaceRef.current) {
        const t = table.getBoundingClientRect();
        const s = surfaceRef.current.getBoundingClientRect();
        setTablePos({ top: Math.max(0, t.top - s.top - 38), left: Math.max(0, t.left - s.left) });
      } else {
        setTablePos(null);
      }
    }
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  function exec(command: string, arg?: string) {
    if (readOnly) return;
    ref.current?.focus();
    document.execCommand(command, false, arg);
    commit();
  }

  // Toggle a block format (h2/h3/blockquote/pre) back to a paragraph on second click
  function block(tag: string) {
    const currentBlock = (document.queryCommandValue("formatBlock") || "").toLowerCase();
    exec("formatBlock", currentBlock === tag ? "<p>" : `<${tag}>`);
  }

  // ── Link dialog ────────────────────────────────────────────────────────────
  function openLink() {
    if (readOnly) return;
    const sel = window.getSelection();
    savedRangeRef.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
    const anchor = node?.closest?.("a") as HTMLAnchorElement | null;
    setLinkUrl(anchor?.getAttribute("href") ?? "");
    setLinkNewTab(anchor?.getAttribute("target") === "_blank");
    setLinkExisting(Boolean(anchor));
    setLinkOpen(true);
  }

  function restoreRange() {
    const sel = window.getSelection();
    if (savedRangeRef.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRangeRef.current);
    }
  }

  function applyLink() {
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!url) return;
    ref.current?.focus();
    restoreRange();
    const sel = window.getSelection();
    const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
    const existing = node?.closest?.("a") as HTMLAnchorElement | null;
    if (existing && ref.current?.contains(existing)) {
      existing.setAttribute("href", url);
      if (linkNewTab) existing.setAttribute("target", "_blank");
      else existing.removeAttribute("target");
    } else if (sel && sel.isCollapsed) {
      document.execCommand("insertHTML", false, `<a href="${url}"${linkNewTab ? ' target="_blank"' : ""}>${url}</a>`);
    } else {
      document.execCommand("createLink", false, url);
      const n = window.getSelection()?.anchorNode;
      const a = (n instanceof Element ? n : n?.parentElement)?.closest?.("a");
      if (a) {
        if (linkNewTab) a.setAttribute("target", "_blank");
        else a.removeAttribute("target");
      }
    }
    commit();
  }

  function removeLink() {
    setLinkOpen(false);
    ref.current?.focus();
    restoreRange();
    document.execCommand("unlink");
    commit();
  }

  // ── Table tools (Beacon's floating toolbar) ────────────────────────────────
  function insertTable() {
    // Like Filament: insertTable({ rows: 2, cols: 3, withHeaderRow: true })
    const th = `<th style="${TH_STYLE}"><br></th>`;
    const td = `<td style="${TD_STYLE}"><br></td>`;
    exec(
      "insertHTML",
      `<table style="border-collapse:collapse;width:100%"><tbody><tr>${th}${th}${th}</tr><tr>${td}${td}${td}</tr></tbody></table><p><br></p>`
    );
  }

  function withCell(fn: (cell: HTMLTableCellElement, table: HTMLTableElement) => void) {
    const cell = activeCellRef.current;
    const table = cell?.closest("table");
    if (!cell || !table) return;
    fn(cell, table as HTMLTableElement);
    commit();
  }

  const colIndex = (cell: HTMLTableCellElement) => Array.prototype.indexOf.call(cell.parentElement!.children, cell);

  function makeCell(headerRow: boolean): HTMLTableCellElement {
    const el = document.createElement(headerRow ? "th" : "td");
    el.setAttribute("style", headerRow ? TH_STYLE : TD_STYLE);
    el.innerHTML = "<br>";
    return el;
  }

  function addColumn(after: boolean) {
    withCell((cell, table) => {
      const idx = colIndex(cell);
      Array.from(table.rows).forEach((row) => {
        const target = row.cells[Math.min(idx, row.cells.length - 1)];
        const fresh = makeCell(target?.tagName === "TH");
        target?.insertAdjacentElement(after ? "afterend" : "beforebegin", fresh);
      });
    });
  }

  function deleteColumn() {
    withCell((cell, table) => {
      if (table.rows[0]?.cells.length <= 1) { table.remove(); setTablePos(null); return; }
      const idx = colIndex(cell);
      Array.from(table.rows).forEach((row) => row.cells[idx]?.remove());
    });
  }

  function addRow(after: boolean) {
    withCell((cell, table) => {
      const row = cell.parentElement as HTMLTableRowElement;
      const fresh = document.createElement("tr");
      Array.from(row.cells).forEach((c) => {
        const copy = makeCell(false);
        if (c.colSpan > 1) copy.colSpan = c.colSpan;
        fresh.appendChild(copy);
      });
      row.insertAdjacentElement(after ? "afterend" : "beforebegin", fresh);
    });
  }

  function deleteRow() {
    withCell((cell, table) => {
      if (table.rows.length <= 1) { table.remove(); setTablePos(null); return; }
      (cell.parentElement as HTMLTableRowElement).remove();
    });
  }

  function mergeCells() {
    withCell((cell) => {
      const next = cell.nextElementSibling as HTMLTableCellElement | null;
      if (!next) return;
      cell.colSpan = (cell.colSpan || 1) + (next.colSpan || 1);
      cell.innerHTML = `${cell.innerHTML} ${next.innerHTML}`.replace(/<br>\s*<br>/g, "<br>");
      next.remove();
    });
  }

  function splitCell() {
    withCell((cell) => {
      if ((cell.colSpan || 1) <= 1) return;
      cell.colSpan = cell.colSpan - 1;
      if (cell.colSpan === 1) cell.removeAttribute("colspan");
      cell.insertAdjacentElement("afterend", makeCell(cell.tagName === "TH"));
    });
  }

  function toggleHeaderRow() {
    withCell((cell, table) => {
      const first = table.rows[0];
      if (!first) return;
      const toTd = first.cells[0]?.tagName === "TH";
      Array.from(first.cells).forEach((c) => {
        const swapped = document.createElement(toTd ? "td" : "th");
        swapped.setAttribute("style", toTd ? TD_STYLE : TH_STYLE);
        if (c.colSpan > 1) swapped.colSpan = c.colSpan;
        swapped.innerHTML = c.innerHTML;
        c.replaceWith(swapped);
      });
    });
  }

  function toggleHeaderCell() {
    withCell((cell) => {
      const toTd = cell.tagName === "TH";
      const swapped = document.createElement(toTd ? "td" : "th");
      swapped.setAttribute("style", toTd ? TD_STYLE : TH_STYLE);
      if (cell.colSpan > 1) swapped.colSpan = cell.colSpan;
      swapped.innerHTML = cell.innerHTML;
      cell.replaceWith(swapped);
      activeCellRef.current = swapped as HTMLTableCellElement;
    });
  }

  function deleteTable() {
    withCell((_cell, table) => {
      table.remove();
      setTablePos(null);
    });
  }

  function attachFile(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      exec("insertHTML", `<img src="${ev.target?.result}" alt="${file.name}" style="max-width:100%;height:auto" />`);
    };
    reader.readAsDataURL(file);
  }

  const tb = (key?: string) =>
    `flex h-8 w-8 items-center justify-center rounded-md transition-colors [&>svg]:h-[18px] [&>svg]:w-[18px] ${
      key && active[key]
        ? "bg-[#054B70]/10 text-[#054B70]"
        : "text-gray-500 hover:bg-gray-100 hover:text-gray-950"
    }`;

  const tools: Array<Array<{ key?: string; label: string; icon: React.ReactNode; run: () => void }>> = [
    [
      { key: "bold", label: "Bold", icon: I.bold, run: () => exec("bold") },
      { key: "italic", label: "Italic", icon: I.italic, run: () => exec("italic") },
      { key: "underline", label: "Underline", icon: I.underline, run: () => exec("underline") },
      { key: "strikeThrough", label: "Strikethrough", icon: I.strike, run: () => exec("strikeThrough") },
      { key: "subscript", label: "Subscript", icon: I.subscript, run: () => exec("subscript") },
      { key: "superscript", label: "Superscript", icon: I.superscript, run: () => exec("superscript") },
      { label: "Link", icon: I.link, run: openLink },
    ],
    [
      { key: "h2", label: "Heading 2", icon: I.h2, run: () => block("h2") },
      { key: "h3", label: "Heading 3", icon: I.h3, run: () => block("h3") },
    ],
    [
      { key: "justifyLeft", label: "Align start", icon: I.alignStart, run: () => exec("justifyLeft") },
      { key: "justifyCenter", label: "Align center", icon: I.alignCenter, run: () => exec("justifyCenter") },
      { key: "justifyRight", label: "Align end", icon: I.alignEnd, run: () => exec("justifyRight") },
    ],
    [
      { key: "blockquote", label: "Blockquote", icon: I.blockquote, run: () => block("blockquote") },
      { key: "pre", label: "Code block", icon: I.codeBlock, run: () => block("pre") },
      { key: "insertUnorderedList", label: "Bullet list", icon: I.bulletList, run: () => exec("insertUnorderedList") },
      { key: "insertOrderedList", label: "Numbered list", icon: I.orderedList, run: () => exec("insertOrderedList") },
    ],
    [
      { label: "Table", icon: I.table, run: insertTable },
      { label: "Attach files", icon: I.attachFiles, run: () => fileRef.current?.click() },
    ],
    [
      { label: "Undo", icon: I.undo, run: () => exec("undo") },
      { label: "Redo", icon: I.redo, run: () => exec("redo") },
    ],
  ];

  const tableTools: Array<{ label: string; run: () => void }> = [
    { label: "+Col ◀", run: () => addColumn(false) },
    { label: "+Col ▶", run: () => addColumn(true) },
    { label: "−Col", run: deleteColumn },
    { label: "+Row ▲", run: () => addRow(false) },
    { label: "+Row ▼", run: () => addRow(true) },
    { label: "−Row", run: deleteRow },
    { label: "Merge", run: mergeCells },
    { label: "Split", run: splitCell },
    { label: "Header row", run: toggleHeaderRow },
    { label: "Header cell", run: toggleHeaderCell },
    { label: "Delete table", run: deleteTable },
  ];

  return (
    <div className="rounded-xl border border-gray-300 bg-gray-50">
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1.5">
          {tools.map((group, gi) => (
            <div key={gi} className="flex items-center gap-0.5">
              {group.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  title={t.label}
                  aria-label={t.label}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={t.run}
                  className={tb(t.key)}
                >
                  {t.icon}
                </button>
              ))}
            </div>
          ))}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) attachFile(f);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {/* Link dialog — URL + open in a new tab, like Filament's link action */}
      {linkOpen && (
        <div className="mx-2 mb-1.5 flex flex-wrap items-end gap-2 rounded-lg bg-white p-2.5 ring-1 ring-gray-950/10">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block text-[12px] font-medium text-gray-950">URL</label>
            <input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applyLink(); if (e.key === "Escape") setLinkOpen(false); }}
              placeholder="https://"
              className="w-full rounded-md bg-gray-50 px-2.5 py-1.5 text-[13px] text-gray-950 outline-none ring-1 ring-gray-950/10 focus:ring-2 focus:ring-[#054B70]"
            />
          </div>
          <label className="mb-1.5 flex select-none items-center gap-1.5 text-[12px] font-medium text-gray-700">
            <input type="checkbox" checked={linkNewTab} onChange={(e) => setLinkNewTab(e.target.checked)} className="accent-[#054B70]" />
            Open in a new tab
          </label>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={applyLink} className="rounded-md bg-[#054B70] px-3 py-1.5 text-[12px] font-bold text-white">Save</button>
            {linkExisting && (
              <button type="button" onClick={removeLink} className="rounded-md border border-red-500/40 px-3 py-1.5 text-[12px] font-semibold text-red-600 hover:bg-red-50">Remove link</button>
            )}
            <button type="button" onClick={() => setLinkOpen(false)} className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">Cancel</button>
          </div>
        </div>
      )}

      {/* Inset typing surface — the whole panel is clickable, like Filament */}
      <div ref={surfaceRef} className={`relative ${readOnly ? "" : "px-1.5 pb-1.5"}`}>
        {/* Floating table toolbar — appears while the caret is inside a table */}
        {!readOnly && tablePos && (
          <div
            className="absolute z-20 flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-white p-1 shadow-lg ring-1 ring-gray-950/10"
            style={{ top: tablePos.top, left: tablePos.left }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {tableTools.map((t) => (
              <button
                key={t.label}
                type="button"
                title={t.label}
                onClick={t.run}
                className="rounded-md px-2 py-1 text-[11px] font-semibold text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-950"
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div
          ref={(el) => {
            ref.current = el;
            if (editorRef) editorRef.current = el;
          }}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
          onPaste={(e) => {
            if (readOnly) return;
            // Pasted HTML *source* (plain text full of tags) should render, not
            // appear as literal <p>…</p> text. Rich pastes already carry a
            // text/html flavor and are left to the browser.
            const html = e.clipboardData.getData("text/html");
            const text = e.clipboardData.getData("text/plain");
            if (!html && text && /<([a-z][a-z0-9]*)\b[^>]*>/i.test(text)) {
              e.preventDefault();
              document.execCommand("insertHTML", false, text);
            }
          }}
          style={{ minHeight }}
          className={`beacon-body-editor w-full bg-white px-4 py-3 text-sm leading-relaxed text-gray-900 outline-none ${
            readOnly ? "cursor-default rounded-xl opacity-70" : "rounded-lg ring-1 ring-gray-950/10"
          }`}
        />
      </div>
    </div>
  );
}
