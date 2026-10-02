import type { ActionFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { syncShop } from "../services/forecast.server";

// Daily re-forecast for every installed shop, so alerts fire even when nobody
// opens the app. Call from any scheduler:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<app>/jobs/sync
export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("Authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shops = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });

  const results = [];
  for (const { shop } of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      results.push({ shop, ok: true, ...(await syncShop(admin, shop)) });
    } catch (error) {
      results.push({ shop, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return Response.json({ synced: results.length, results });
};
