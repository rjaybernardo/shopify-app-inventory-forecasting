// Orchestrates sync -> persist -> forecast -> alert for a shop.
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ShopSettings, VariantForecast } from "@prisma/client";
import db from "../db.server";
import {
  STATUS_META,
  addDays,
  dayKey,
  forecast,
  formatDays,
  formatDate,
  statusRank,
  type Status,
} from "../lib/forecast";
import {
  fetchInventoryItemVariant,
  fetchOrderLines,
  fetchTrackedVariants,
  type OrderLine,
  type ShopVariant,
} from "./shopify-data.server";
import { escapeHtml, sendEmail, sendSms } from "./notify.server";

type Admin = Pick<AdminApiContext, "graphql">;

const RETENTION_DAYS = 90;
const CHUNK = 200;

export async function getSettings(shop: string) {
  return db.shopSettings.upsert({ where: { shop }, update: {}, create: { shop } });
}

const startOfDay = (d: Date) => new Date(`${dayKey(d)}T00:00:00.000Z`);
export const windowStart = (now: Date, lookbackDays: number) =>
  addDays(startOfDay(now), -(lookbackDays - 1));

async function inChunks<T>(items: T[], fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += CHUNK) await fn(items.slice(i, i + CHUNK));
}

export async function saveOrderLines(shop: string, lines: OrderLine[]) {
  await inChunks(lines, (chunk) =>
    db.$transaction(
      chunk.map((l) =>
        db.saleLine.upsert({
          where: { shop_lineItemId: { shop, lineItemId: l.lineItemId } },
          update: { quantity: l.quantity },
          create: { shop, ...l },
        }),
      ),
    ),
  );
}

async function snapshot(shop: string, items: { variantId: string; available: number }[]) {
  const day = dayKey(new Date());
  await inChunks(items, (chunk) =>
    db.$transaction(
      chunk.map(({ variantId, available }) =>
        db.inventorySnapshot.upsert({
          where: { shop_variantId_day: { shop, variantId, day } },
          update: { available },
          create: { shop, variantId, day, available },
        }),
      ),
    ),
  );
}

// Recomputes forecasts. `meta` carries fresh catalog data from a sync; variants
// without it reuse what is already stored (webhook path).
export async function recompute(
  shop: string,
  opts: { variantIds?: string[]; meta?: Map<string, ShopVariant> } = {},
) {
  const settings = await getSettings(shop);
  const now = new Date();
  const start = windowStart(now, settings.lookbackDays);
  const days = Array.from({ length: settings.lookbackDays }, (_, i) =>
    dayKey(addDays(start, i)),
  );
  const variantFilter = opts.variantIds ? { variantId: { in: opts.variantIds } } : {};

  const [existing, lines, snapshots, overrides] = await Promise.all([
    db.variantForecast.findMany({ where: { shop, ...variantFilter } }),
    db.saleLine.findMany({
      where: { shop, orderedAt: { gte: start }, ...variantFilter },
      select: { variantId: true, quantity: true, orderedAt: true },
    }),
    db.inventorySnapshot.findMany({
      where: { shop, day: { gte: days[0] }, ...variantFilter },
    }),
    db.variantSetting.findMany({ where: { shop, ...variantFilter } }),
  ]);

  const sales = new Map<string, Map<string, number>>();
  for (const l of lines) {
    const byDay = sales.get(l.variantId) ?? new Map<string, number>();
    const key = dayKey(l.orderedAt);
    byDay.set(key, (byDay.get(key) ?? 0) + l.quantity);
    sales.set(l.variantId, byDay);
  }
  const outDays = new Set(
    snapshots.filter((s) => s.available <= 0).map((s) => `${s.variantId}|${s.day}`),
  );
  const overrideBy = new Map(overrides.map((o) => [o.variantId, o]));
  const existingBy = new Map(existing.map((e) => [e.variantId, e]));

  const variantIds = new Set([...existingBy.keys(), ...(opts.meta?.keys() ?? [])]);
  const writes = [...variantIds].flatMap((variantId) => {
    const meta = opts.meta?.get(variantId) ?? existingBy.get(variantId);
    if (!meta) return [];
    const override = overrideBy.get(variantId);
    const byDay = sales.get(variantId);
    const result = forecast(
      {
        available: meta.available,
        dailySales: days.map((d) => byDay?.get(d) ?? 0),
        stockedOut: days.map((d) => outDays.has(`${variantId}|${d}`)),
      },
      {
        leadTimeDays: override?.leadTimeDays ?? settings.leadTimeDays,
        safetyStockDays: override?.safetyStockDays ?? settings.safetyStockDays,
        warningDays: settings.warningDays,
        coverageDays: settings.coverageDays,
      },
      now,
    );
    const data = {
      productId: meta.productId,
      productTitle: meta.productTitle,
      variantTitle: meta.variantTitle,
      sku: meta.sku,
      imageUrl: meta.imageUrl,
      price: meta.price,
      available: meta.available,
      unitsSold: result.unitsSold,
      velocity: result.velocity,
      recentVelocity: result.recentVelocity,
      trend: result.trend,
      daysOfCover: result.daysOfCover,
      stockoutDate: result.stockoutDate,
      reorderPoint: result.reorderPoint,
      reorderByDate: result.reorderByDate,
      suggestedQty: result.suggestedQty,
      status: result.status,
    };
    return [
      db.variantForecast.upsert({
        where: { shop_variantId: { shop, variantId } },
        update: data,
        create: { shop, variantId, ...data },
      }),
    ];
  });

  await inChunks(writes, (chunk) => db.$transaction(chunk));
}

export async function syncShop(admin: Admin, shop: string) {
  const settings = await getSettings(shop);
  const now = new Date();
  const start = windowStart(now, settings.lookbackDays);
  // Overlap the previous sync by a day so nothing slips between runs.
  const updatedSince = settings.lastOrderSyncAt
    ? addDays(settings.lastOrderSyncAt, -1)
    : start;

  const [{ variants, currencyCode }, lines] = await Promise.all([
    fetchTrackedVariants(admin),
    fetchOrderLines(admin, start, updatedSince),
  ]);

  await saveOrderLines(shop, lines);
  await snapshot(shop, variants);

  const meta = new Map(variants.map((v) => [v.variantId, v]));
  await db.variantForecast.deleteMany({
    where: { shop, variantId: { notIn: [...meta.keys()] } },
  });
  await recompute(shop, { meta });

  const cutoff = addDays(now, -RETENTION_DAYS);
  await db.saleLine.deleteMany({ where: { shop, orderedAt: { lt: cutoff } } });
  await db.inventorySnapshot.deleteMany({ where: { shop, day: { lt: dayKey(cutoff) } } });

  await db.shopSettings.update({
    where: { shop },
    data: { currencyCode, lastSyncedAt: now, lastOrderSyncAt: now },
  });

  const alerts = await evaluateAlerts(shop);
  return { variants: variants.length, orderLines: lines.length, alerts };
}

// Webhook path: orders/create, orders/updated, orders/cancelled.
export async function applyOrderWebhook(
  shop: string,
  payload: {
    id: number;
    created_at: string;
    cancelled_at?: string | null;
    test?: boolean;
    line_items?: {
      id: number;
      variant_id: number | null;
      quantity: number;
      current_quantity?: number;
    }[];
  },
) {
  if (payload.test) return;
  const lines: OrderLine[] = (payload.line_items ?? [])
    .filter((li) => li.variant_id)
    .map((li) => ({
      lineItemId: `gid://shopify/LineItem/${li.id}`,
      orderId: `gid://shopify/Order/${payload.id}`,
      variantId: `gid://shopify/ProductVariant/${li.variant_id}`,
      quantity: payload.cancelled_at ? 0 : (li.current_quantity ?? li.quantity),
      orderedAt: new Date(payload.created_at),
    }));
  if (lines.length === 0) return;

  await saveOrderLines(shop, lines);
  const variantIds = [...new Set(lines.map((l) => l.variantId))];
  await recompute(shop, { variantIds });
  await evaluateAlerts(shop, variantIds);
}

// Webhook path: inventory_levels/update.
export async function applyInventoryWebhook(
  admin: Admin,
  shop: string,
  inventoryItemId: number,
) {
  const item = await fetchInventoryItemVariant(
    admin,
    `gid://shopify/InventoryItem/${inventoryItemId}`,
  );
  if (!item) return;

  const updated = await db.variantForecast.updateMany({
    where: { shop, variantId: item.variantId },
    data: { available: item.available },
  });
  // Unknown variants (e.g. brand-new products) are picked up by the next full sync.
  if (updated.count === 0) return;

  await snapshot(shop, [item]);
  await recompute(shop, { variantIds: [item.variantId] });
  await evaluateAlerts(shop, [item.variantId]);
}

// Sends one digest per channel for variants that newly crossed the alert level,
// got worse, or have been at risk longer than the reminder interval.
export async function evaluateAlerts(shop: string, variantIds?: string[]) {
  const settings = await getSettings(shop);
  const threshold = statusRank(settings.alertLevel);
  const now = new Date();
  const rows = await db.variantForecast.findMany({
    where: { shop, ...(variantIds ? { variantId: { in: variantIds } } : {}) },
  });

  const recovered = rows.filter((r) => r.alertedStatus && statusRank(r.status) > threshold);
  if (recovered.length) {
    await db.variantForecast.updateMany({
      where: { id: { in: recovered.map((r) => r.id) } },
      data: { alertedStatus: null, alertedAt: null },
    });
  }

  const remindBefore = addDays(now, -settings.remindAfterDays);
  const due = rows
    .filter((r) => statusRank(r.status) <= threshold)
    .filter(
      (r) =>
        !r.alertedStatus ||
        statusRank(r.status) < statusRank(r.alertedStatus) ||
        (r.alertedAt && r.alertedAt < remindBefore),
    )
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0));

  const channels = channelsFor(settings);
  if (due.length === 0 || channels.length === 0) return 0;

  const subject =
    due.length === 1
      ? `Stock alert: ${label(due[0])} — ${STATUS_META[due[0].status as Status].label}`
      : `Stock alert: ${due.length} variants need attention`;
  const items = JSON.stringify(
    due.map((r) => ({
      variantId: r.variantId,
      title: label(r),
      status: r.status,
      available: r.available,
      daysOfCover: r.daysOfCover,
      suggestedQty: r.suggestedQty,
    })),
  );

  for (const channel of channels) {
    const delivered =
      channel.type === "EMAIL"
        ? await sendEmail(channel.to, subject, emailHtml(shop, due))
        : await sendSms(channel.to, smsBody(due));
    await db.alert.create({
      data: {
        shop,
        channel: channel.type,
        recipient: channel.to,
        subject,
        itemCount: due.length,
        items,
        delivered,
      },
    });
  }

  await db.$transaction(
    due.map((r) =>
      db.variantForecast.update({
        where: { id: r.id },
        data: { alertedStatus: r.status, alertedAt: now },
      }),
    ),
  );
  return due.length;
}

export function channelsFor(settings: ShopSettings) {
  const channels: { type: "EMAIL" | "SMS"; to: string }[] = [];
  if (settings.emailEnabled && settings.alertEmail)
    channels.push({ type: "EMAIL", to: settings.alertEmail });
  if (settings.smsEnabled && settings.alertPhone)
    channels.push({ type: "SMS", to: settings.alertPhone });
  return channels;
}

const label = (r: Pick<VariantForecast, "productTitle" | "variantTitle">) =>
  r.variantTitle && r.variantTitle !== "Default Title"
    ? `${r.productTitle} – ${r.variantTitle}`
    : r.productTitle;

export const variantLabel = label;

function appUrl(shop: string) {
  return `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY ?? ""}`;
}

function emailHtml(shop: string, rows: VariantForecast[]) {
  const cell = "padding:8px 10px;border-bottom:1px solid #eee;text-align:left";
  const body = rows
    .slice(0, 50)
    .map(
      (r) => `<tr>
        <td style="${cell}">${escapeHtml(label(r))}${r.sku ? `<br><span style="color:#6b6b6b">${escapeHtml(r.sku)}</span>` : ""}</td>
        <td style="${cell}">${STATUS_META[r.status as Status].label}</td>
        <td style="${cell}">${r.available}</td>
        <td style="${cell}">${formatDays(r.daysOfCover)}<br><span style="color:#6b6b6b">${formatDate(r.stockoutDate)}</span></td>
        <td style="${cell}"><strong>${r.suggestedQty}</strong></td>
      </tr>`,
    )
    .join("");
  const more = rows.length > 50 ? `<p>…and ${rows.length - 50} more in the app.</p>` : "";

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a">
    <h2 style="margin:0 0 8px">Reorder before you run out</h2>
    <p style="margin:0 0 16px;color:#4a4a4a">${rows.length} variant(s) on ${escapeHtml(shop)} are forecast to stock out soon.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr>
        <th style="${cell}">Variant</th><th style="${cell}">Status</th><th style="${cell}">Available</th>
        <th style="${cell}">Stock left</th><th style="${cell}">Reorder qty</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${more}
    <p style="margin-top:24px"><a href="${escapeHtml(appUrl(shop))}" style="display:inline-block;background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open Inventory Forecasting</a></p>
  </div>`;
}

function smsBody(rows: VariantForecast[]) {
  const top = rows
    .slice(0, 3)
    .map((r) =>
      r.available <= 0
        ? `${label(r)}: out of stock`
        : `${label(r)}: ${r.available} left (${formatDays(r.daysOfCover)})`,
    )
    .join("; ");
  const more = rows.length > 3 ? ` +${rows.length - 3} more` : "";
  return `Stock alert: ${top}${more}. Open the Inventory Forecasting app to reorder.`;
}
