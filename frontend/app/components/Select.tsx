"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";

const SPRING = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.8 };

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value?: string;
  onChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** Compact trigger (e.g. the per-page picker). */
  size?: "sm" | "md";
  /** Multi-select: `values` holds the picks, clicks toggle, the panel stays open. */
  multiple?: boolean;
  values?: string[];
  onToggle?: (value: string) => void;
  /** Filament-style search box at the top of the panel. */
  searchable?: boolean;
}

/**
 * Filament-style replacement for native <select>: styled trigger, portaled
 * dropdown panel (never clipped), check mark on the selected option.
 */
export default function Select({
  value = "",
  onChange = () => {},
  options,
  placeholder = "Select…",
  className = "",
  disabled = false,
  size = "md",
  multiple = false,
  values = [],
  onToggle,
  searchable = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number }>({ top: 0, left: 0, width: 160, maxH: 300 });

  const shown = searchable && search.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  const selected = options.find((o) => o.value === value);
  const selectedMany = multiple ? options.filter((o) => values.includes(o.value)) : [];
  const triggerLabel = multiple
    ? (selectedMany.length ? selectedMany.map((o) => o.label).join(", ") : "")
    : (selected ? selected.label : "");
  const hasValue = multiple ? selectedMany.length > 0 : Boolean(selected);

  function reposition() {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Always prefer opening DOWNWARD: clamp the panel to the space below and let
    // it scroll internally. Only flip above as a last resort when the space
    // below is unusably small AND there's clearly more room above.
    const desired = Math.min(office(options.length) + (searchable ? 46 : 0) + 10, 300);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    let top: number;
    let maxH: number;
    if (spaceBelow >= 150 || spaceBelow >= spaceAbove) {
      top = rect.bottom + 4;
      maxH = Math.min(desired, Math.max(120, spaceBelow));
    } else {
      maxH = Math.min(desired, Math.max(120, spaceAbove));
      top = Math.max(8, rect.top - maxH - 4);
    }
    const width = Math.max(rect.width, 140);
    setPos({ top, left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8), width, maxH });
  }

  function office(n: number) {
    return n * 36; // approx option height for flip maths
  }

  useEffect(() => {
    if (!open) return;
    setSearch("");
    reposition();
    if (searchable) setTimeout(() => searchRef.current?.focus(), 30);
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pad = size === "sm" ? "px-2.5 py-1.5 text-[12px]" : "px-3 py-2.5 text-[13px]";

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg bg-white ${pad} text-left shadow-sm outline-none transition duration-75 disabled:cursor-not-allowed disabled:opacity-60 ${
          open ? "ring-2 ring-[#054B70]" : "ring-1 ring-gray-950/10 hover:ring-gray-950/20"
        } ${hasValue ? "text-gray-950" : "text-gray-400"}`}
      >
        <span className="truncate">{hasValue ? triggerLabel : placeholder}</span>
        <svg
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
        >
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, scale: 0.97, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={SPRING}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH, transformOrigin: "top left" }}
          className="z-[80] overflow-y-auto rounded-lg bg-white p-1 shadow-lg ring-1 ring-gray-950/5"
        >
          {searchable && (
            <div className="sticky top-0 z-10 mb-1 bg-white p-1">
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Start typing to search..."
                aria-label="Search"
                className="w-full rounded-md bg-gray-50 px-2.5 py-1.5 text-[13px] text-gray-950 placeholder-gray-400 outline-none ring-1 ring-gray-950/10 focus:ring-2 focus:ring-[#054B70]"
              />
            </div>
          )}
          {options.length === 0 && (
            <p className="px-3 py-2 text-[13px] text-gray-400">No options available.</p>
          )}
          {options.length > 0 && shown.length === 0 && (
            <p className="px-3 py-2 text-[13px] text-gray-400">No options match your search.</p>
          )}
          {shown.map((o) => {
            const isSelected = multiple ? values.includes(o.value) : o.value === value;
            return (
              <button
                key={o.value || "__blank"}
                type="button"
                onClick={() => {
                  if (multiple) {
                    onToggle?.(o.value);
                  } else {
                    onChange(o.value);
                    setOpen(false);
                  }
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-[13px] transition-colors duration-75 ${
                  isSelected ? "bg-gray-100 font-medium text-gray-950" : "text-gray-950 hover:bg-gray-50"
                }`}
              >
                <span className="truncate">{o.label}</span>
                {isSelected && (
                  <svg className="h-4 w-4 shrink-0 text-[#054B70]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </motion.div>,
        document.body
      )}
    </div>
  );
}
