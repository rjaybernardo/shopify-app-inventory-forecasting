import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSettings, syncShop, variantLabel } from "../services/forecast.server";
import {
  addDays,
  formatDate,
  formatDays,
  formatMoney,
  formatVelocity,
  numericId,
  statusRank,
} from "../lib/forecast";
import { StatusBadge } from "../components/StatusBadge";

const FILTERS = {
  at_risk: { label: "Needs attention", statuses: ["OUT_OF_STOCK", "CRITICAL", "REORDER", "WATCH"] },
  reorder: { label: "Reorder now", statuses: ["OUT_OF_STOCK", "CRITICAL", "REORDER"] },
  healthy: { label: "Healthy", statuses: ["HEALTHY"] },
  no_sales: { label: "No sales", statuses: ["NO_SALES"] },
  all: { label: "All", statuses: null },
} as const;
type FilterKey = keyof typeof FILTERS;
const PAGE_SIZE = 250;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  let settings = await getSettings(shop);

  // First visit: run the initial backfill so the merchant lands on real data.
  let syncError: string | null = null;
  if (!settings.lastSyncedAt) {
    try {
      await syncShop(admin, shop);
      settings = await getSettings(shop);
    } catch (error) {
      syncError = error instanceof Error ? error.message : "Initial sync failed";
    }
  }

  const url = new URL(request.url);
  const filter = (url.searchParams.get("status") ?? "at_risk") as FilterKey;
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const active = FILTERS[filter] ?? FILTERS.at_risk;

  const all = await db.variantForecast.findMany({ where: { shop } });
  const now = new Date();
  const horizon = addDays(now, 30);
  const count = (statuses: readonly string[] | null) =>
    statuses ? all.filter((f) => statuses.includes(f.status)).length : all.length;

  const rows = all
    .filter((f) => !active.statuses || (active.statuses as readonly string[]).includes(f.status))
    .filter(
      (f) =>
        !q ||
        f.productTitle.toLowerCase().includes(q) ||
        f.variantTitle.toLowerCase().includes(q) ||
        (f.sku ?? "").toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) ||
        b.velocity - a.velocity,
    );

  return {
    filter: active === FILTERS[filter] ? filter : "at_risk",
    q,
    syncError,
    lastSyncedAt: settings.lastSyncedAt?.toISOString() ?? null,
    currency: settings.currencyCode,
    leadTimeDays: settings.leadTimeDays,
    counts: Object.fromEntries(
      Object.entries(FILTERS).map(([k, f]) => [k, count(f.statuses)]),
    ) as Record<FilterKey, number>,
    kpis: {
      tracked: all.length,
      outOfStock: count(["OUT_OF_STOCK"]),
      reorderNow: count(["CRITICAL", "REORDER"]),
      stockoutsSoon: all.filter(
        (f) => f.status !== "OUT_OF_STOCK" && f.stockoutDate && f.stockoutDate <= horizon,
      ).length,
      // Revenue/day that is already lost or will be before a reorder could arrive.
      dailyRevenueAtRisk: all
        .filter((f) => f.status === "OUT_OF_STOCK" || f.status === "CRITICAL")
        .reduce((sum, f) => sum + f.velocity * f.price, 0),
    },
    total: rows.length,
    rows: rows.slice(0, PAGE_SIZE).map((f) => ({
      id: numericId(f.variantId),
      title: variantLabel(f),
      sku: f.sku,
      imageUrl: f.imageUrl,
      status: f.status,
      available: f.available,
      velocity: f.velocity,
      trend: f.trend,
      daysOfCover: f.daysOfCover,
      stockoutDate: f.stockoutDate?.toISOString() ?? null,
      reorderByDate: f.reorderByDate?.toISOString() ?? null,
      suggestedQty: f.suggestedQty,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    const result = await syncShop(admin, session.shop);
    return { ok: true as const, ...result };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Sync failed" };
  }
};

export default function Dashboard() {
  const { rows, total, kpis, counts, filter, q, currency, lastSyncedAt, syncError, leadTimeDays } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const syncing = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      const { variants, orderLines, alerts } = fetcher.data;
      shopify.toast.show(
        `Synced ${variants} variants, ${orderLines} order lines${alerts ? ` · ${alerts} alerted` : ""}`,
      );
    } else {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Inventory Forecasting">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => fetcher.submit({}, { method: "POST" })}
        {...(syncing ? { loading: true } : {})}
      >
        Sync now
      </s-button>
      <s-button slot="secondary-actions" onClick={downloadReorderList}>
        Export reorder list
      </s-button>

      {syncError && (
        <s-banner tone="critical" heading="Couldn't sync with Shopify">
          {syncError}
        </s-banner>
      )}

      <s-section padding="base">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          <Metric label="Out of stock" value={kpis.outOfStock.toLocaleString()}>
            {kpis.tracked.toLocaleString()} tracked variants
          </Metric>
          <Metric label="Reorder now" value={kpis.reorderNow.toLocaleString()}>
            At or below reorder point
          </Metric>
          <Metric label="Stockouts in 30 days" value={kpis.stockoutsSoon.toLocaleString()}>
            Based on current velocity
          </Metric>
          <Metric label="Sales at risk / day" value={formatMoney(kpis.dailyRevenueAtRisk, currency)}>
            Out of stock or critical
          </Metric>
        </s-grid>
      </s-section>

      <s-section padding="none" accessibilityLabel="Variant forecasts">
        <s-box padding="base">
          <s-stack gap="base">
            <s-stack direction="inline" gap="small-200">
              {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((key) => (
                <s-button
                  key={key}
                  href={`/app?status=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                  variant={key === filter ? "primary" : "secondary"}
                >
                  {`${FILTERS[key].label} (${counts[key]})`}
                </s-button>
              ))}
            </s-stack>
            <Form method="get">
              <input type="hidden" name="status" value={filter} />
              <s-search-field
                label="Search"
                labelAccessibilityVisibility="exclusive"
                name="q"
                placeholder="Search by product, variant or SKU"
                defaultValue={q}
              />
            </Form>
          </s-stack>
        </s-box>

        {rows.length === 0 ? (
          <s-box padding="large-200">
            <s-stack gap="small-200" alignItems="center">
              <s-heading>
                {kpis.tracked === 0 ? "No tracked inventory yet" : "Nothing here"}
              </s-heading>
              <s-paragraph color="subdued">
                {kpis.tracked === 0
                  ? "Turn on inventory tracking for your products, then sync to generate forecasts."
                  : filter === "at_risk"
                    ? "No variant is approaching its reorder point. Nice."
                    : "No variants match this filter."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Variant</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header format="numeric">Available</s-table-header>
              <s-table-header format="numeric">Velocity</s-table-header>
              <s-table-header listSlot="labeled">Stock left</s-table-header>
              <s-table-header>Reorder by</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                Suggested qty
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={r.id} clickDelegate={`variant-${r.id}`}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-300" alignItems="center">
                      <s-thumbnail size="small-200" src={r.imageUrl ?? undefined} alt="" />
                      <s-stack gap="small-500">
                        <s-link id={`variant-${r.id}`} href={`/app/variants/${r.id}`}>
                          {r.title}
                        </s-link>
                        {r.sku && <s-text color="subdued">{r.sku}</s-text>}
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <StatusBadge status={r.status} />
                  </s-table-cell>
                  <s-table-cell>{r.available.toLocaleString()}</s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-500">
                      <s-text>{formatVelocity(r.velocity)}</s-text>
                      {r.trend !== null && Math.abs(r.trend) >= 0.1 && (
                        <s-text color="subdued">
                          {`${r.trend > 0 ? "▲" : "▼"} ${Math.round(Math.abs(r.trend) * 100)}%`}
                        </s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-500">
                      <s-text>{formatDays(r.daysOfCover)}</s-text>
                      <s-text color="subdued">
                        {r.stockoutDate ? `Out ${formatDate(r.stockoutDate)}` : ""}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {r.reorderByDate
                      ? new Date(r.reorderByDate) <= new Date()
                        ? "Today"
                        : formatDate(r.reorderByDate)
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {r.suggestedQty > 0 ? r.suggestedQty.toLocaleString() : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {total > rows.length && (
          <s-box padding="base">
            <s-text color="subdued">
              {`Showing the ${rows.length} most urgent of ${total.toLocaleString()} variants. Search to narrow down.`}
            </s-text>
          </s-box>
        )}
      </s-section>

      <s-section slot="aside" heading="How forecasts work">
        <s-stack gap="small-300">
          <s-paragraph>
            Velocity is a weighted average of the last 14 days and the full
            lookback window. Days a variant was out of stock are excluded, so a
            stockout doesn&apos;t read as low demand.
          </s-paragraph>
          <s-paragraph>
            {`Reorder point = velocity × ${leadTimeDays}-day lead time + safety stock.`}
          </s-paragraph>
          <s-text color="subdued">
            {lastSyncedAt
              ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}`
              : "Not synced yet"}
          </s-text>
          <s-link href="/app/settings">Adjust thresholds</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

// App Bridge adds the session token to same-origin fetches; a plain link
// opened in a new tab would not be authenticated.
async function downloadReorderList() {
  const response = await fetch("/app/reorder.csv");
  if (!response.ok) {
    shopify.toast.show("Couldn't export the reorder list", { isError: true });
    return;
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download =
    response.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] ??
    "reorder-list.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function Metric({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        <s-text color="subdued">{children}</s-text>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
