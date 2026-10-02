import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { STATUS_META, dayKey, statusRank, type Status } from "../lib/forecast";

// Purchase-order-ready CSV of every variant that needs reordering.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rows = await db.variantForecast.findMany({
    where: { shop: session.shop, suggestedQty: { gt: 0 } },
  });
  rows.sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.suggestedQty - a.suggestedQty);

  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "Product", "Variant", "SKU", "Status", "Available", "Units/day",
    "Days of stock", "Stockout date", "Reorder by", "Reorder point", "Suggested qty",
  ];
  const lines = rows.map((r) =>
    [
      r.productTitle,
      r.variantTitle === "Default Title" ? "" : r.variantTitle,
      r.sku,
      STATUS_META[r.status as Status]?.label ?? r.status,
      r.available,
      r.velocity.toFixed(2),
      r.daysOfCover?.toFixed(1),
      r.stockoutDate && dayKey(r.stockoutDate),
      r.reorderByDate && dayKey(r.reorderByDate),
      r.reorderPoint,
      r.suggestedQty,
    ]
      .map(esc)
      .join(","),
  );

  return new Response([header.join(","), ...lines].join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="reorder-list-${dayKey(new Date())}.csv"`,
    },
  });
};
