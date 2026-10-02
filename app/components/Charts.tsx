// Lightweight inline-SVG charts (no chart library): one y-axis each, a hover
// crosshair/tooltip, and recessive grid lines.
import { useId, useState, type MouseEvent } from "react";

const W = 640;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 36 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

const COLORS = {
  series: "#2a78d6",
  projection: "#2a78d6",
  reference: "#eb6834",
  critical: "#e34948",
  grid: "#e3e3e3",
  axis: "#616161",
};

function niceMax(v: number) {
  if (v <= 0) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= v / 4)! * pow;
  return Math.ceil(v / step) * step;
}

const shortDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

function Frame({
  max,
  labels,
  title,
  children,
  onHover,
  tooltip,
}: {
  max: number;
  labels: string[];
  title: string;
  children: React.ReactNode;
  onHover: (i: number | null) => void;
  tooltip: React.ReactNode;
}) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const step = Math.max(1, Math.ceil(labels.length / 6));
  const x = (i: number) => PAD.left + (labels.length <= 1 ? 0 : (i / (labels.length - 1)) * INNER_W);
  const titleId = useId();

  const move = (e: MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - box.left) / box.width;
    onHover(Math.min(labels.length - 1, Math.max(0, Math.round(ratio * (labels.length - 1)))));
  };

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-labelledby={titleId}>
        <title id={titleId}>{title}</title>
        {ticks.map((t) => {
          const y = PAD.top + INNER_H - (t / max) * INNER_H;
          return (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke={COLORS.grid} strokeWidth={1} />
              <text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize={11} fill={COLORS.axis}>
                {Number.isInteger(t) ? t : t.toFixed(1)}
              </text>
            </g>
          );
        })}
        {labels.map((l, i) =>
          i % step === 0 || i === labels.length - 1 ? (
            <text key={l} x={x(i)} y={H - 6} textAnchor="middle" fontSize={11} fill={COLORS.axis}>
              {shortDate(l)}
            </text>
          ) : null,
        )}
        {children}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={INNER_W}
          height={INNER_H}
          fill="transparent"
          onMouseMove={move}
          onMouseLeave={() => onHover(null)}
        />
      </svg>
      {tooltip}
    </div>
  );
}

function Tooltip({ x, lines }: { x: number; lines: [string, string][] }) {
  const left = `${(x / W) * 100}%`;
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left,
        transform: x > W * 0.65 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
        background: "#fff",
        border: "1px solid #e3e3e3",
        borderRadius: 8,
        boxShadow: "0 4px 12px rgba(0,0,0,.08)",
        padding: "6px 10px",
        fontSize: 12,
        lineHeight: 1.5,
        pointerEvents: "none",
        whiteSpace: "nowrap",
      }}
    >
      {lines.map(([k, v], i) => (
        <div key={k} style={{ fontWeight: i === 0 ? 600 : 400, color: i === 0 ? "#303030" : "#616161" }}>
          {k}
          {v && <span style={{ color: "#303030", marginLeft: 8, fontVariantNumeric: "tabular-nums" }}>{v}</span>}
        </div>
      ))}
    </div>
  );
}

// Stock on hand: observed history (solid) then the forecast (dashed), with the
// reorder point as a reference line.
export function StockChart({
  history,
  projection,
  reorderPoint,
}: {
  history: { day: string; available: number | null }[];
  projection: { day: string; available: number }[];
  reorderPoint: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const points = [
    ...history.map((h) => ({ ...h, projected: false })),
    ...projection.slice(1).map((p) => ({ ...p, projected: true })),
  ];
  const max = niceMax(
    Math.max(reorderPoint, ...points.map((p) => p.available ?? 0)) * 1.1,
  );
  const x = (i: number) => PAD.left + (points.length <= 1 ? 0 : (i / (points.length - 1)) * INNER_W);
  const y = (v: number) => PAD.top + INNER_H - (v / max) * INNER_H;

  const path = (from: number, to: number) => {
    let d = "";
    let pen = false;
    for (let i = from; i <= to; i++) {
      const v = points[i]?.available;
      if (v === null || v === undefined) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const todayIdx = history.length - 1;
  const stockoutIdx = points.findIndex((p, i) => i > todayIdx && (p.available ?? 1) <= 0);
  const h = hover !== null ? points[hover] : null;

  return (
    <Frame
      max={max}
      labels={points.map((p) => p.day)}
      title="Stock on hand: recorded history and forecast"
      onHover={setHover}
      tooltip={
        h && hover !== null ? (
          <Tooltip
            x={x(hover)}
            lines={[
              [shortDate(h.day), h.projected ? "forecast" : hover === todayIdx ? "today" : ""],
              ["Available", h.available === null ? "not recorded" : String(Math.round(h.available))],
              ["Reorder point", String(reorderPoint)],
            ]}
          />
        ) : null
      }
    >
      {reorderPoint > 0 && (
        <g>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(reorderPoint)}
            y2={y(reorderPoint)}
            stroke={COLORS.reference}
            strokeWidth={1.5}
            strokeDasharray="2 3"
          />
          <text x={W - PAD.right - 4} y={y(reorderPoint) - 5} textAnchor="end" fontSize={11} fill={COLORS.axis}>
            Reorder point {reorderPoint}
          </text>
        </g>
      )}
      <line x1={x(todayIdx)} x2={x(todayIdx)} y1={PAD.top} y2={PAD.top + INNER_H} stroke={COLORS.grid} strokeWidth={1} />
      <text x={x(todayIdx) + 4} y={PAD.top + 10} fontSize={11} fill={COLORS.axis}>
        Today
      </text>
      <path d={path(0, todayIdx)} fill="none" stroke={COLORS.series} strokeWidth={2} strokeLinejoin="round" />
      <path
        d={path(todayIdx, points.length - 1)}
        fill="none"
        stroke={COLORS.projection}
        strokeWidth={2}
        strokeDasharray="6 4"
      />
      {stockoutIdx > 0 && (
        <g>
          <circle cx={x(stockoutIdx)} cy={y(0)} r={5} fill={COLORS.critical} stroke="#fff" strokeWidth={2} />
          <text x={x(stockoutIdx)} y={y(0) - 10} textAnchor="middle" fontSize={11} fill={COLORS.axis}>
            Stockout
          </text>
        </g>
      )}
      {h && hover !== null && h.available !== null && (
        <g pointerEvents="none">
          <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + INNER_H} stroke={COLORS.axis} strokeWidth={1} opacity={0.4} />
          <circle cx={x(hover)} cy={y(h.available)} r={4} fill={COLORS.series} stroke="#fff" strokeWidth={2} />
        </g>
      )}
    </Frame>
  );
}

// Units sold per day, with the forecast velocity as a reference line.
export function SalesChart({
  sales,
  velocity,
}: {
  sales: { day: string; units: number }[];
  velocity: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(velocity, ...sales.map((s) => s.units)) * 1.1);
  const slot = INNER_W / Math.max(sales.length, 1);
  const barW = Math.max(2, Math.min(18, slot - 2));
  const cx = (i: number) => PAD.left + (sales.length <= 1 ? 0 : (i / (sales.length - 1)) * INNER_W);
  const y = (v: number) => PAD.top + INNER_H - (v / max) * INNER_H;
  const h = hover !== null ? sales[hover] : null;

  return (
    <Frame
      max={max}
      labels={sales.map((s) => s.day)}
      title="Units sold per day"
      onHover={setHover}
      tooltip={
        h && hover !== null ? (
          <Tooltip
            x={cx(hover)}
            lines={[
              [shortDate(h.day), ""],
              ["Units sold", String(h.units)],
              ["Forecast velocity", `${velocity.toFixed(1)}/day`],
            ]}
          />
        ) : null
      }
    >
      {sales.map((s, i) => {
        if (s.units === 0) return null;
        const top = y(s.units);
        const height = PAD.top + INNER_H - top;
        const r = Math.min(4, barW / 2, height);
        const left = cx(i) - barW / 2;
        const bottom = PAD.top + INNER_H;
        return (
          <path
            key={s.day}
            d={`M${left},${bottom}V${top + r}Q${left},${top} ${left + r},${top}H${left + barW - r}Q${left + barW},${top} ${left + barW},${top + r}V${bottom}Z`}
            fill={COLORS.series}
            opacity={hover === null || hover === i ? 1 : 0.55}
          />
        );
      })}
      {velocity > 0 && (
        <g>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(velocity)}
            y2={y(velocity)}
            stroke={COLORS.reference}
            strokeWidth={1.5}
            strokeDasharray="2 3"
          />
          <text x={PAD.left + 4} y={y(velocity) - 5} fontSize={11} fill={COLORS.axis}>
            Velocity {velocity.toFixed(1)}/day
          </text>
        </g>
      )}
    </Frame>
  );
}
