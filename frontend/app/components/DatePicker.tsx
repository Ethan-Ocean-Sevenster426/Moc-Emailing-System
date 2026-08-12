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

// Easter Sunday (anonymous Gregorian algorithm) — for Good Friday / Easter Monday
function easterSunday(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Widely-observed holidays when inboxes go quiet. */
export function holidayName(d: Date): string | null {
  const m = d.getMonth() + 1, day = d.getDate();
  if (m === 1 && day === 1) return "New Year's Day";
  if (m === 5 && day === 1) return "Workers' Day";
  if (m === 12 && day === 24) return "Christmas Eve";
  if (m === 12 && day === 25) return "Christmas Day";
  if (m === 12 && day === 26) return "Boxing Day";
  if (m === 12 && day === 31) return "New Year's Eve";
  const easter = easterSunday(d.getFullYear());
  const goodFriday = new Date(easter); goodFriday.setDate(easter.getDate() - 2);
  const easterMonday = new Date(easter); easterMonday.setDate(easter.getDate() + 1);
  if (sameDay(d, goodFriday)) return "Good Friday";
  if (sameDay(d, easterMonday)) return "Easter Monday";
  return null;
}

/** Friendly heads-up when a picked date is likely to underperform. */
export function dateAdvice(d: Date): string | null {
  const hol = holidayName(d);
  if (hol) return `Heads up — that's ${hol}. Most people are away from their inbox over holidays, so this email may go unread. A regular working day usually lands better.`;
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return `Heads up — that's a ${dow === 0 ? "Sunday" : "Saturday"}. Business emails sent on weekends tend to sit unread until Monday morning's pile-up.`;
  if (dow === 1) return "Heads up — that's a Monday. Inboxes are at their fullest after the weekend, so emails are easy to miss. Tuesday to Thursday usually gets more attention.";
  if (dow === 5) return "Heads up — that's a Friday. Emails often get parked for the weekend and forgotten. Tuesday to Thursday usually gets more attention.";
  return null;
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
  // Which header dropdown (month/year) is open — custom panels, not native selects
  const [headerMenu, setHeaderMenu] = useState<"" | "month" | "year">("");

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
    setHeaderMenu("");
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

      {/* Friendly heads-up for holidays, Mondays/Fridays and weekends */}
      {selectedDate && dateAdvice(selectedDate) && (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium leading-snug text-amber-700">
          <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span>{dateAdvice(selectedDate)}</span>
        </p>
      )}

      {/* Panel — portaled to <body> so overflow-hidden ancestors can't clip it */}
      {open && typeof document !== "undefined" && createPortal(
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, scale: 0.95, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.8 }}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: PANEL_W, transformOrigin: "top left" }}
          className="z-[80] rounded-lg bg-white p-4 shadow-lg ring-1 ring-gray-950/5">
          {/* Header — custom month + year dropdowns (styled like Select), chevron steppers */}
          <div className="relative mb-2 flex items-center justify-between gap-1">
            <div className="flex flex-1 items-center gap-1">
              <button
                type="button"
                onClick={() => setHeaderMenu(headerMenu === "month" ? "" : "month")}
                className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-gray-950 transition-colors hover:bg-gray-100 ${headerMenu === "month" ? "bg-gray-100" : ""}`}
              >
                {MONTHS[viewMonth]}
                <svg className={`h-3.5 w-3.5 text-gray-400 transition-transform ${headerMenu === "month" ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M19 9l-7 7-7-7" /></svg>
              </button>
              <button
                type="button"
                onClick={() => setHeaderMenu(headerMenu === "year" ? "" : "year")}
                className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-gray-950 transition-colors hover:bg-gray-100 ${headerMenu === "year" ? "bg-gray-100" : ""}`}
              >
                {viewYear}
                <svg className={`h-3.5 w-3.5 text-gray-400 transition-transform ${headerMenu === "year" ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M19 9l-7 7-7-7" /></svg>
              </button>
            </div>
            {headerMenu === "month" && (
              <div className="absolute left-0 top-9 z-10 max-h-52 w-40 overflow-y-auto rounded-lg bg-white p-1 shadow-lg ring-1 ring-gray-950/10">
                {MONTHS.map((m, i) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => { setViewMonth(i); setHeaderMenu(""); }}
                    className={`block w-full rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
                      i === viewMonth ? "bg-[#054B70]/5 font-semibold text-[#054B70]" : "text-gray-950 hover:bg-gray-100"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
            {headerMenu === "year" && (
              <div className="absolute left-24 top-9 z-10 max-h-52 w-24 overflow-y-auto rounded-lg bg-white p-1 shadow-lg ring-1 ring-gray-950/10">
                {Array.from({ length: 21 }, (_, i) => today.getFullYear() - 10 + i).map((y) => (
                  <button
                    key={y}
                    type="button"
                    onClick={() => { setViewYear(y); setHeaderMenu(""); }}
                    className={`block w-full rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
                      y === viewYear ? "bg-[#054B70]/5 font-semibold text-[#054B70]" : "text-gray-950 hover:bg-gray-100"
                    }`}
                  >
                    {y}
                  </button>
                ))}
              </div>
            )}
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
              const hol = holidayName(d);
              return (
                <button
                  key={dStr}
                  type="button"
                  disabled={disallowed}
                  onClick={() => pickDay(d)}
                  title={hol || undefined}
                  className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full text-[13px] transition duration-75 ${
                    isSelected
                      ? "bg-[#054B70] font-medium text-white"
                      : disallowed
                      ? "cursor-not-allowed text-gray-300"
                      : hol && inMonth
                      ? "font-medium text-amber-600 hover:bg-amber-50"
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
