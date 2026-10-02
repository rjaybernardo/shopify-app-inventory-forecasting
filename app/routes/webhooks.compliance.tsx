import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory privacy webhooks: customers/data_request, customers/redact, shop/redact.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // The app stores order line quantities only — no customer data.
      break;
    case "SHOP_REDACT":
      await db.$transaction([
        db.saleLine.deleteMany({ where: { shop } }),
        db.inventorySnapshot.deleteMany({ where: { shop } }),
        db.variantForecast.deleteMany({ where: { shop } }),
        db.variantSetting.deleteMany({ where: { shop } }),
        db.alert.deleteMany({ where: { shop } }),
        db.shopSettings.deleteMany({ where: { shop } }),
      ]);
      break;
  }

  return new Response();
};
