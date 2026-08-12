"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";

const PRIMARY = "#054B70";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

interface DatePickerProps {
  /** Controlled value: "yyyy-MM-dd", or "yyyy-MM-ddTHH:mm" when withTime. */
  value?: string;
  /** Uncontrolled initial value (same formats). */
  defaultValue?: string;
  onChange?: (value: string) => void;
  withTime?: boolean;
  /** JS getDay() values that may be picked (e.g. [2,3,4] = Tue/Wed/Thu). Others are disabled. */
  allowedWeekdays?: number[];
  placeholder?: string;
  /** Renders a hidden <input id=...> kept in sync, for code that reads the value via getElementById. */
  inputId?: string;
  className?: string;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toDateStr(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function splitValue(v: string): { date: string; time: string } {
  if (!v) return { date: "", time: "" };
  const [date, time] = v.split("T");
  return { date: date || "", time: (time || "").slice(0, 5) };
}

export default function DatePicker({
  value,
  defaultValue,
  onChange,
  withTime = false,
  allowedWeekdays,
  placeholder,
  inputId,
  className = "",
}: DatePickerProps) {
  const controlled = value !== undefined;
  const [internal, setInternal] = useState(defaultValue || "");
  const current = controlled ? (value as string) : internal;
  const { date: datePart, time: timePart } = splitValue(current);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Panel position (fixed, portaled to <body> so card/modal overflow can't clip it)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const today = new Date();
  const selectedDate = datePart ? new Date(`${datePart}T00:00:00`) : null;
  const [viewYear, setViewYear] = useState((selectedDate || today).getFullYear());
  const [viewMonth, setViewMonth] = useState((selectedDate || today).getMonth());

  const PANEL_W = 288;
  const PANEL_H = withTime ? 430 : 390;

  function reposition() {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(rect.left, window.innerWidth - PANEL_W - 8);
    const top = rect.bottom + PANEL_H > window.innerHeight
      ? Math.max(8, rect.top - PANEL_H - 4)
      : rect.bottom + 4;
    setPos({ top, left: Math.max(8, left) });
  }

  // Close on outside click / Escape; keep the panel glued to the trigger
  useEffect(() => {
    if (!open) return;
    reposition();
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

  function emit(next: string) {
    if (!controlled) setInternal(next);
    onChange?.(next);
  }

  function pickDay(d: Date) {
    const dateStr = toDateStr(d);
    emit(withTime ? `${dateStr}T${timePart || "09:00"}` : dateStr);
    if (!withTime) setOpen(false);
  }

  function setTime(t: string) {
    const dateStr = datePart || toDateStr(today);
    emit(`${dateStr}T${t}`);
  }

  function clear() {
    emit("");
    setOpen(false);
  }

  function goToday() {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    if (!allowedWeekdays || allowedWeekdays.includes(today.getDay())) pickDay(today);
  }

  function shiftMonth(delta: number) {
    const d = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  }

  // 6×7 grid starting on Sunday, like the Filament calendar
  const grid = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [viewYear, viewMonth]);

  const display = useMemo(() => {
    if (!datePart) return "";
    const d = new Date(`${datePart}T00:00:00`);
    const label = `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
    return withTime && timePart ? `${label}, ${timePart}` : label;
  }, [datePart, timePart, withTime]);

  const todayStr = toDateStr(today);

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      {inputId && <input type="hidden" id={inputId} value={current} readOnly />}

      {/* Trigger — Filament text-input style: white, ring border, calendar prefix icon */}
      <button
        type="button"
        onClick={() => {
          if (!open && selectedDate) {
            setViewYear(selectedDate.getFullYear());
            setViewMonth(selectedDate.getMonth());
          }
          setOpen(!open);
        }}
        className={`flex w-full items-center gap-2 rounded-lg bg-white px-3 py-2 text-left text-[13px] shadow-sm outline-none transition duration-75 ${
          open ? "ring-2 ring-[#054B70]" : "ring-1 ring-gray-950/10 hover:ring-gray-950/20"
        } ${display ? "text-gray-950" : "text-gray-400"}`}
      >
        <svg className="h-4 w-4 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="truncate">{display || placeholder || (withTime ? "Pick date & time" : "Pick a date")}</span>
      </button>

      {/* Panel — portaled to <body> so overflow-hidden ancestors can't clip it */}
      {open && typeof document !== "undefined" && createPortal(
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, scale: 0.95, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.8 }}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: PANEL_W, transformOrigin: "top left" }}
          className="z-[80] rounded-lg bg-white p-4 shadow-lg ring-1 ring-gray-950/5">
          {/* Header — Filament style: month + year selects, chevron steppers */}
          <div className="mb-2 flex items-center justify-between gap-1">
            <div className="flex flex-1 items-center gap-1">
              <select
                value={viewMonth}
                onChange={(e) => setViewMonth(Number(e.target.value))}
                className="flex-1 cursor-pointer rounded-lg border-0 bg-transparent py-1 pl-1 pr-6 text-[13px] font-medium text-gray-950 outline-none hover:bg-gray-50 focus:ring-2 focus:ring-[#054B70]"
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i}>{m}</option>
                ))}
              </select>
              <select
                value={viewYear}
                onChange={(e) => setViewYear(Number(e.target.value))}
                className="cursor-pointer rounded-lg border-0 bg-transparent py-1 pl-1 pr-6 text-[13px] font-medium text-gray-950 outline-none hover:bg-gray-50 focus:ring-2 focus:ring-[#054B70]"
              >
                {Array.from({ length: 21 }, (_, i) => today.getFullYear() - 10 + i).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div className="flex">
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-500"
                title="Previous month"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M15 19l-7-7 7-7" /></svg>
              </button>
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-500"
                title="Next month"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
          </div>

          {/* Weekday header */}
          <div className="mb-1 grid grid-cols-7">
            {WEEKDAYS.map((w) => (
              <span key={w} className="flex h-8 items-center justify-center text-[12px] font-medium text-gray-500">
                {w}
              </span>
            ))}
          </div>

          {/* Days — Filament's circular cells */}
          <div className="grid grid-cols-7 gap-y-1">
            {grid.map((d) => {
              const dStr = toDateStr(d);
              const inMonth = d.getMonth() === viewMonth;
              const isSelected = dStr === datePart;
              const isToday = dStr === todayStr;
              const disallowed = !!allowedWeekdays && !allowedWeekdays.includes(d.getDay());
              return (
                <button
                  key={dStr}
                  type="button"
                  disabled={disallowed}
                  onClick={() => pickDay(d)}
                  className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full text-[13px] transition duration-75 ${
                    isSelected
                      ? "bg-[#054B70] font-medium text-white"
                      : disallowed
                      ? "cursor-not-allowed text-gray-300"
                      : isToday
                      ? "font-medium text-[#054B70] hover:bg-gray-100"
                      : inMonth
                      ? "text-gray-950 hover:bg-gray-100"
                      : "text-gray-400 hover:bg-gray-50"
                  }`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          {/* Time */}
          {withTime && (
            <div className="mt-2 flex items-center gap-2 border-t border-gray-100 pt-2">
              <span className="text-[11px] font-semibold text-gray-500">Time</span>
              <input
                type="time"
                value={timePart || "09:00"}
                onChange={(e) => setTime(e.target.value)}
                className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-[12px] text-gray-900 outline-none focus:border-[#054B70]"
              />
            </div>
          )}

          {/* Footer */}
          <div className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2">
            <button type="button" onClick={clear} className="rounded-lg px-2 py-1 text-[12px] font-semibold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700">
              Clear
            </button>
            <button
              type="button"
              onClick={goToday}
              disabled={!!allowedWeekdays && !allowedWeekdays.includes(today.getDay())}
              className="rounded-lg px-2 py-1 text-[12px] font-semibold transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
              style={{ color: !!allowedWeekdays && !allowedWeekdays.includes(today.getDay()) ? undefined : PRIMARY }}
            >
              Today
            </button>
          </div>
        </motion.div>,
        document.body
      )}
    </div>
  );
}
