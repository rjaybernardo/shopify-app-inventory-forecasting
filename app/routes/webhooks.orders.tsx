import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyOrderWebhook } from "../services/forecast.server";

// orders/create, orders/updated, orders/cancelled: keep sales velocity live between syncs.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  await applyOrderWebhook(shop, payload as Parameters<typeof applyOrderWebhook>[1]);

  return new Response();
};
