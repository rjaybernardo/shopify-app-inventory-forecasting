import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  evaluateAlerts,
  getSettings,
  recompute,
  variantLabel,
  windowStart,
} from "../services/forecast.server";
import {
  STATUS_META,
  addDays,
  dayKey,
  formatDate,
  formatDays,
  formatMoney,
  formatVelocity,
  numericId,
  projectInventory,
  type Status,
} from "../lib/forecast";
import { StatusBadge } from "../components/StatusBadge";
import { SalesChart, StockChart } from "../components/Charts";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const variantId = `gid://shopify/ProductVariant/${params.id}`;

  const [settings, f, override] = await Promise.all([
    getSettings(shop),
    db.variantForecast.findUnique({ where: { shop_variantId: { shop, variantId } } }),
    db.variantSetting.findUnique({ where: { shop_variantId: { shop, variantId } } }),
  ]);
  if (!f) throw new Response("Variant not found", { status: 404 });

  const start = windowStart(new Date(), settings.lookbackDays);
  const days = Array.from({ length: settings.lookbackDays }, (_, i) => dayKey(addDays(start, i)));
  const [lines, snapshots] = await Promise.all([
    db.saleLine.findMany({
      where: { shop, variantId, orderedAt: { gte: start } },
      select: { quantity: true, orderedAt: true },
    }),
    db.inventorySnapshot.findMany({ where: { shop, variantId, day: { gte: days[0] } } }),
  ]);

  const sold = new Map<string, number>();
  for (const l of lines) {
    const k = dayKey(l.orderedAt);
    sold.set(k, (sold.get(k) ?? 0) + l.quantity);
  }
  const onHand = new Map(snapshots.map((s) => [s.day, s.available]));
  onHand.set(days[days.length - 1], f.available);

  const horizon = Math.min(
    60,
    Math.max(14, Math.ceil((f.daysOfCover ?? 0) + 7)),
  );
  const projection = projectInventory(f.available, f.velocity, horizon).map((available, i) => ({
    day: dayKey(addDays(new Date(), i)),
    available,
  }));

  const leadTimeDays = override?.leadTimeDays ?? settings.leadTimeDays;
  const safetyStockDays = override?.safetyStockDays ?? settings.safetyStockDays;

  return {
    variant: {
      id: params.id!,
      productId: numericId(f.productId),
      title: variantLabel(f),
      sku: f.sku,
      imageUrl: f.imageUrl,
      status: f.status,
      available: f.available,
      unitsSold: f.unitsSold,
      velocity: f.velocity,
      recentVelocity: f.recentVelocity,
      trend: f.trend,
      daysOfCover: f.daysOfCover,
      stockoutDate: f.stockoutDate?.toISOString() ?? null,
      reorderByDate: f.reorderByDate?.toISOString() ?? null,
      reorderPoint: f.reorderPoint,
      suggestedQty: f.suggestedQty,
      price: f.price,
    },
    currency: settings.currencyCode,
    lookbackDays: settings.lookbackDays,
    coverageDays: settings.coverageDays,
    leadTimeDays,
    safetyStockDays,
    defaults: { leadTimeDays: settings.leadTimeDays, safetyStockDays: settings.safetyStockDays },
    override: {
      leadTimeDays: override?.leadTimeDays ?? null,
      safetyStockDays: override?.safetyStockDays ?? null,
    },
    sales: days.map((day) => ({ day, units: sold.get(day) ?? 0 })),
    history: days.map((day) => ({ day, available: onHand.get(day) ?? null })),
    projection,
  };
};

const optionalDays = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Math.round(Number(s));
  return Number.isFinite(n) && n >= 0 && n <= 365 ? n : NaN;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const variantId = `gid://shopify/ProductVariant/${params.id}`;
  const form = await request.formData();
  const leadTimeDays = optionalDays(form.get("leadTimeDays"));
  const safetyStockDays = optionalDays(form.get("safetyStockDays"));

  if (Number.isNaN(leadTimeDays) || Number.isNaN(safetyStockDays)) {
    return { ok: false, message: "Use whole days between 0 and 365, or leave blank" };
  }

  if (leadTimeDays === null && safetyStockDays === null) {
    await db.variantSetting.deleteMany({ where: { shop, variantId } });
  } else {
    await db.variantSetting.upsert({
      where: { shop_variantId: { shop, variantId } },
      update: { leadTimeDays, safetyStockDays },
      create: { shop, variantId, leadTimeDays, safetyStockDays },
    });
  }
  await recompute(shop, { variantIds: [variantId] });
  await evaluateAlerts(shop, [variantId]);
  return { ok: true, message: "Forecast updated" };
};

export default function VariantForecast() {
  const data = useLoaderData<typeof loader>();
  const { variant: v, currency } = data;
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const meta = STATUS_META[v.status as Status];

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading={v.title}>
      <s-link slot="breadcrumb-actions" href="/app">
        Forecast
      </s-link>
      <s-button
        slot="secondary-actions"
        href={`shopify://admin/products/${v.productId}/variants/${v.id}`}
        target="_top"
      >
        Edit in Shopify
      </s-button>

      {meta && v.status !== "HEALTHY" && v.status !== "NO_SALES" && (
        <s-banner
          tone={meta.tone === "critical" ? "critical" : "warning"}
          heading={
            v.suggestedQty > 0
              ? `${meta.label}: reorder ${v.suggestedQty} units`
              : meta.label
          }
        >
          {meta.help}
          {v.reorderByDate &&
            ` Place the order by ${formatDate(v.reorderByDate)} to keep ${data.safetyStockDays} days of safety stock.`}
        </s-banner>
      )}

      <s-section padding="base">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          <Metric label="Available" value={v.available.toLocaleString()}>
            <StatusBadge status={v.status} />
          </Metric>
          <Metric label="Stock left" value={formatDays(v.daysOfCover)}>
            {v.stockoutDate ? `Sells out ${formatDate(v.stockoutDate)}` : "No stockout predicted"}
          </Metric>
          <Metric label="Velocity" value={formatVelocity(v.velocity)}>
            {v.trend === null
              ? `${v.unitsSold} sold in ${data.lookbackDays} days`
              : `${v.trend >= 0 ? "▲" : "▼"} ${Math.round(Math.abs(v.trend) * 100)}% vs prior 2 weeks`}
          </Metric>
          <Metric label="Suggested reorder" value={v.suggestedQty.toLocaleString()}>
            {`≈ ${formatMoney(v.suggestedQty * v.price, currency)} at retail`}
          </Metric>
        </s-grid>
      </s-section>

      <s-section heading="Stock on hand">
        <s-stack gap="small-200">
          <s-text color="subdued">
            Recorded daily from syncs and inventory webhooks; dashed line is the forecast.
          </s-text>
          <StockChart
            history={data.history}
            projection={data.projection}
            reorderPoint={v.reorderPoint}
          />
        </s-stack>
      </s-section>

      <s-section heading={`Units sold per day · last ${data.lookbackDays} days`}>
        <SalesChart sales={data.sales} velocity={v.velocity} />
      </s-section>

      <s-section slot="aside" heading="The math">
        <s-stack gap="small-200">
          <Row k="Recent velocity (14d)" v={formatVelocity(v.recentVelocity)} />
          <Row k="Weighted velocity" v={formatVelocity(v.velocity)} />
          <Row k="Lead time" v={`${data.leadTimeDays} days`} />
          <Row k="Safety stock" v={`${data.safetyStockDays} days`} />
          <Row k="Reorder point" v={`${v.reorderPoint} units`} />
          <Row k="Order covers" v={`${data.coverageDays} days after arrival`} />
          <s-divider />
          <s-text color="subdued">
            Suggested qty = velocity × (lead time + coverage) + safety stock − available.
          </s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Thresholds for this variant">
        <fetcher.Form method="post">
          <s-stack gap="base">
            <s-number-field
              label="Lead time (days)"
              name="leadTimeDays"
              min={0}
              max={365}
              placeholder={`Shop default: ${data.defaults.leadTimeDays}`}
              defaultValue={data.override.leadTimeDays?.toString() ?? ""}
            />
            <s-number-field
              label="Safety stock (days)"
              name="safetyStockDays"
              min={0}
              max={365}
              placeholder={`Shop default: ${data.defaults.safetyStockDays}`}
              defaultValue={data.override.safetyStockDays?.toString() ?? ""}
              details="Leave blank to use the shop default."
            />
            <s-button
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Save &amp; re-forecast
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <s-stack direction="inline" justifyContent="space-between">
      <s-text color="subdued">{k}</s-text>
      <s-text>{v}</s-text>
    </s-stack>
  );
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
