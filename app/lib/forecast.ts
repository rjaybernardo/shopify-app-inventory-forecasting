// Pure forecasting math, shared by the server (sync/webhooks) and the UI.
// No I/O here so it is trivially testable.

export const STATUSES = [
  "OUT_OF_STOCK",
  "CRITICAL",
  "REORDER",
  "WATCH",
  "HEALTHY",
  "NO_SALES",
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_META: Record<
  Status,
  { label: string; tone: "critical" | "warning" | "caution" | "info" | "success" | "neutral"; help: string }
> = {
  OUT_OF_STOCK: { label: "Out of stock", tone: "critical", help: "No available units. Every day out of stock is lost sales." },
  CRITICAL: { label: "Critical", tone: "critical", help: "Will sell out before a reorder placed today could arrive." },
  REORDER: { label: "Reorder now", tone: "warning", help: "At or below the reorder point (lead time + safety stock)." },
  WATCH: { label: "Watch", tone: "caution", help: "Approaching the reorder point within the warning window." },
  HEALTHY: { label: "Healthy", tone: "success", help: "Enough stock to cover lead time, safety stock and warning window." },
  NO_SALES: { label: "No recent sales", tone: "neutral", help: "No sales in the lookback window, so no stockout is predicted." },
};

// Lower rank = more urgent.
export const statusRank = (s: string) => {
  const i = STATUSES.indexOf(s as Status);
  return i === -1 ? STATUSES.length : i;
};

export interface ForecastSettings {
  leadTimeDays: number;
  safetyStockDays: number;
  warningDays: number;
  coverageDays: number;
}

export interface ForecastInput {
  available: number;
  // Units sold per day, oldest first; the last element is today.
  dailySales: number[];
  // Parallel to dailySales: true when the variant was out of stock that day.
  // Those days are excluded from velocity so a stockout doesn't look like low demand.
  stockedOut?: boolean[];
}

export interface ForecastResult {
  unitsSold: number;
  velocity: number;
  recentVelocity: number;
  trend: number | null;
  daysOfCover: number | null;
  stockoutDate: Date | null;
  reorderPoint: number;
  safetyStock: number;
  reorderByDate: Date | null;
  suggestedQty: number;
  status: Status;
}

const RECENT_WINDOW = 14;
const RECENT_WEIGHT = 0.6;
const DAY_MS = 86_400_000;

function rate(sales: number[], stockedOut: boolean[]) {
  let units = 0;
  let days = 0;
  sales.forEach((u, i) => {
    if (stockedOut[i] && u === 0) return;
    units += u;
    days += 1;
  });
  return days === 0 ? 0 : units / days;
}

export function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

export function forecast(
  input: ForecastInput,
  settings: ForecastSettings,
  today: Date = new Date(),
): ForecastResult {
  const { available, dailySales } = input;
  const stockedOut = [...(input.stockedOut ?? dailySales.map(() => false))];
  // Snapshots only exist since install. If the variant is out of stock now, its
  // trailing run of zero-sale days is almost certainly the stockout itself.
  if (available <= 0) {
    for (let i = dailySales.length - 1; i >= 0 && dailySales[i] === 0; i--) {
      stockedOut[i] = true;
    }
  }
  const unitsSold = dailySales.reduce((a, b) => a + b, 0);

  const recentStart = Math.max(0, dailySales.length - RECENT_WINDOW);
  const longVelocity = rate(dailySales, stockedOut);
  const recentVelocity = rate(
    dailySales.slice(recentStart),
    stockedOut.slice(recentStart),
  );
  // Weighted moving average: reacts to recent demand without overreacting to one spike.
  const velocity =
    dailySales.length > RECENT_WINDOW
      ? RECENT_WEIGHT * recentVelocity + (1 - RECENT_WEIGHT) * longVelocity
      : longVelocity;

  const previousStart = Math.max(0, recentStart - RECENT_WINDOW);
  const previousVelocity = rate(
    dailySales.slice(previousStart, recentStart),
    stockedOut.slice(previousStart, recentStart),
  );
  const trend =
    recentStart > 0 && previousVelocity > 0
      ? recentVelocity / previousVelocity - 1
      : null;

  const { leadTimeDays, safetyStockDays, warningDays, coverageDays } = settings;
  const safetyStock = Math.ceil(velocity * safetyStockDays);
  const reorderPoint = Math.ceil(velocity * leadTimeDays) + safetyStock;
  const suggestedQty = Math.max(
    0,
    Math.ceil(velocity * (leadTimeDays + coverageDays)) + safetyStock - Math.max(available, 0),
  );

  if (velocity <= 0) {
    return {
      unitsSold,
      velocity: 0,
      recentVelocity: 0,
      trend,
      daysOfCover: null,
      stockoutDate: null,
      reorderPoint: 0,
      safetyStock: 0,
      reorderByDate: null,
      suggestedQty: 0,
      status: available <= 0 ? "OUT_OF_STOCK" : "NO_SALES",
    };
  }

  const daysOfCover = Math.max(available, 0) / velocity;
  const stockoutDate = addDays(today, daysOfCover);
  // Last day to place a PO so it lands before stock dips into the safety buffer.
  const reorderByDate = addDays(today, daysOfCover - leadTimeDays - safetyStockDays);

  let status: Status;
  if (available <= 0) status = "OUT_OF_STOCK";
  else if (daysOfCover < leadTimeDays) status = "CRITICAL";
  else if (available <= reorderPoint) status = "REORDER";
  else if (daysOfCover < leadTimeDays + safetyStockDays + warningDays) status = "WATCH";
  else status = "HEALTHY";

  return {
    unitsSold,
    velocity,
    recentVelocity,
    trend,
    daysOfCover,
    stockoutDate,
    reorderPoint,
    safetyStock,
    reorderByDate,
    suggestedQty,
    status,
  };
}

// Projected available units for each of the next `days` days.
export function projectInventory(available: number, velocity: number, days: number) {
  return Array.from({ length: days + 1 }, (_, i) =>
    Math.max(0, available - velocity * i),
  );
}

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export const formatDays = (days: number | null) => {
  if (days === null) return "—";
  if (days < 1) return "< 1 day";
  if (days > 365) return "> 1 year";
  return `${Math.round(days)} days`;
};

export const formatVelocity = (v: number) =>
  v === 0 ? "0/day" : v < 0.1 ? `${(v * 7).toFixed(1)}/wk` : `${v.toFixed(1)}/day`;

export const formatMoney = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: amount >= 1000 ? 0 : 2,
  }).format(amount);

export const formatDate = (iso: string | Date | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "—";

export const numericId = (gid: string) => gid.split("/").pop() ?? gid;
