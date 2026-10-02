import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyInventoryWebhook } from "../services/forecast.server";

// inventory_levels/update: refresh available stock and re-forecast that variant.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  // No admin context means the app was uninstalled; nothing to update.
  if (admin) {
    await applyInventoryWebhook(admin, shop, payload.inventory_item_id as number);
  }

  return new Response();
};
