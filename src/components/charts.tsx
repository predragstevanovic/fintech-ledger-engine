"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DailyPoint } from "@/core/dashboard/dashboard.queries";

/** Validated categorical slots for the dark surface (#11141d): see dataviz validator. */
const SERIES_1 = "#7c6cff";
const SERIES_2 = "#33a89e";
const GRID = "#232838";
const AXIS = "#646b80";

// Presentation layer only: minor units → major units for plotting (ADR-001).
const major = (v: string) => Number(BigInt(v)) / 100;

function compact(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function TooltipBox({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; payload: { count?: number } }>;
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 text-ink-dim">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-ink-dim">{p.name}</span>
          <span className="num ml-auto text-ink">{money(p.value, currency)}</span>
        </div>
      ))}
      {payload[0].payload.count !== undefined ? (
        <div className="mt-1 text-ink-faint">{payload[0].payload.count} payments</div>
      ) : null}
    </div>
  );
}

const day = (d: string) => d.slice(5).replace("-", "/");

export function VolumeChart({ data, currency }: { data: DailyPoint[]; currency: string }) {
  const rows = data.map((d) => ({ day: day(d.day), "Gross volume": major(d.gross), count: d.count }));
  return (
    <div className="h-64" role="img" aria-label="Daily gross payment volume, last 30 days">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES_1} stopOpacity={0.35} />
              <stop offset="100%" stopColor={SERIES_1} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="day" stroke={AXIS} tickLine={false} axisLine={false} fontSize={11} interval={4} />
          <YAxis stroke={AXIS} tickLine={false} axisLine={false} fontSize={11} width={48} tickFormatter={(v) => compact(v, currency)} />
          <Tooltip content={<TooltipBox currency={currency} />} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
          <Area type="monotone" dataKey="Gross volume" stroke={SERIES_1} strokeWidth={2} fill="url(#vol)" activeDot={{ r: 4, stroke: "#11141d", strokeWidth: 2 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RevenueFeesChart({ data, currency }: { data: DailyPoint[]; currency: string }) {
  const rows = data.slice(-14).map((d) => ({ day: day(d.day), "Platform revenue": major(d.revenue), "PSP fees": major(d.fees) }));
  return (
    <div className="h-64" role="img" aria-label="Daily platform revenue versus PSP fees, last 14 days">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="day" stroke={AXIS} tickLine={false} axisLine={false} fontSize={11} interval={1} />
          <YAxis stroke={AXIS} tickLine={false} axisLine={false} fontSize={11} width={48} tickFormatter={(v) => compact(v, currency)} />
          <Tooltip content={<TooltipBox currency={currency} />} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "#9aa1b5" }} />
          <Bar dataKey="Platform revenue" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={14} />
          <Bar dataKey="PSP fees" fill={SERIES_2} radius={[4, 4, 0, 0]} maxBarSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
