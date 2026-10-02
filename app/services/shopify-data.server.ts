// Read-only Admin GraphQL access: tracked variants, recent orders, inventory items.
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

type Admin = Pick<AdminApiContext, "graphql">;

// Guardrails so one sync stays within a request's time budget.
// Larger catalogs should move to bulkOperationRunQuery.
const MAX_VARIANT_PAGES = 20; // 5,000 variants
const MAX_ORDER_PAGES = 120; // 3,000 orders

async function run<T>(
  admin: Admin,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const json = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (!json.data) {
    throw new Error(json.errors?.map((e) => e.message).join("; ") || "GraphQL request failed");
  }
  return json.data;
}

export interface ShopVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  imageUrl: string | null;
  price: number;
  available: number;
}

export async function fetchTrackedVariants(admin: Admin) {
  const variants: ShopVariant[] = [];
  let currencyCode = "USD";
  let after: string | null = null;

  for (let page = 0; page < MAX_VARIANT_PAGES; page++) {
    const data: {
      shop: { currencyCode: string };
      productVariants: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          title: string;
          sku: string | null;
          price: string;
          inventoryQuantity: number | null;
          inventoryItem: { tracked: boolean };
          product: {
            id: string;
            title: string;
            status: string;
            featuredMedia: { preview: { image: { url: string } | null } | null } | null;
          };
        }[];
      };
    } = await run(
      admin,
      `#graphql
      query IfVariants($after: String) {
        shop { currencyCode }
        productVariants(first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            sku
            price
            inventoryQuantity
            inventoryItem { tracked }
            product {
              id
              title
              status
              featuredMedia { preview { image { url(transform: { maxWidth: 120 }) } } }
            }
          }
        }
      }`,
      { after },
    );

    currencyCode = data.shop.currencyCode;
    for (const v of data.productVariants.nodes) {
      // Untracked inventory can't stock out; archived products aren't for sale.
      if (!v.inventoryItem.tracked || v.product.status === "ARCHIVED") continue;
      variants.push({
        variantId: v.id,
        productId: v.product.id,
        productTitle: v.product.title,
        variantTitle: v.title,
        sku: v.sku || null,
        imageUrl: v.product.featuredMedia?.preview?.image?.url ?? null,
        price: Number(v.price) || 0,
        available: v.inventoryQuantity ?? 0,
      });
    }

    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }

  return { variants, currencyCode };
}

export interface OrderLine {
  lineItemId: string;
  orderId: string;
  variantId: string;
  quantity: number;
  orderedAt: Date;
}

// Orders created inside the lookback window and updated since `updatedSince`,
// so refunds and cancellations on older orders are picked up incrementally.
export async function fetchOrderLines(
  admin: Admin,
  createdSince: Date,
  updatedSince: Date,
) {
  const lines: OrderLine[] = [];
  const ts = (d: Date) => `'${d.toISOString().slice(0, 19)}Z'`;
  const query = `created_at:>=${ts(createdSince)} AND updated_at:>=${ts(updatedSince)}`;
  let after: string | null = null;

  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const data: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          createdAt: string;
          cancelledAt: string | null;
          test: boolean;
          lineItems: {
            nodes: { id: string; currentQuantity: number; variant: { id: string } | null }[];
          };
        }[];
      };
    } = await run(
      admin,
      `#graphql
      query IfOrders($after: String, $query: String!) {
        orders(first: 25, after: $after, query: $query, sortKey: UPDATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            createdAt
            cancelledAt
            test
            lineItems(first: 30) {
              nodes { id currentQuantity variant { id } }
            }
          }
        }
      }`,
      { after, query },
    );

    for (const order of data.orders.nodes) {
      if (order.test) continue;
      for (const item of order.lineItems.nodes) {
        if (!item.variant) continue;
        lines.push({
          lineItemId: item.id,
          orderId: order.id,
          variantId: item.variant.id,
          quantity: order.cancelledAt ? 0 : item.currentQuantity,
          orderedAt: new Date(order.createdAt),
        });
      }
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }

  return lines;
}

// Total available units across locations for the variant behind an inventory item.
export async function fetchInventoryItemVariant(admin: Admin, inventoryItemId: string) {
  const data = await run<{
    inventoryItem: {
      tracked: boolean;
      variants: { nodes: { id: string; inventoryQuantity: number | null }[] };
    } | null;
  }>(
    admin,
    `#graphql
    query IfInventoryItem($id: ID!) {
      inventoryItem(id: $id) {
        tracked
        variants(first: 1) { nodes { id inventoryQuantity } }
      }
    }`,
    { id: inventoryItemId },
  );
  const variant = data.inventoryItem?.variants.nodes[0];
  if (!variant || !data.inventoryItem?.tracked) return null;
  return { variantId: variant.id, available: variant.inventoryQuantity ?? 0 };
}
