import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { channelsFor, getSettings } from "../services/forecast.server";
import { numericId } from "../lib/forecast";
import { StatusBadge } from "../components/StatusBadge";

interface AlertItem {
  variantId: string;
  title: string;
  status: string;
  available: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [settings, alerts] = await Promise.all([
    getSettings(session.shop),
    db.alert.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  return {
    channels: channelsFor(settings).map((c) => c.type),
    alerts: alerts.map((a) => ({
      id: a.id,
      channel: a.channel,
      recipient: a.recipient,
      subject: a.subject,
      delivered: a.delivered,
      createdAt: a.createdAt.toISOString(),
      items: (JSON.parse(a.items) as AlertItem[]).slice(0, 5),
      itemCount: a.itemCount,
    })),
  };
};

export default function Alerts() {
  const { alerts, channels } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Alerts">
      {channels.length === 0 && (
        <s-banner tone="warning" heading="Alerts are turned off">
          Turn on email or SMS alerts in <s-link href="/app/settings">Settings</s-link> to
          hear about stockouts before they happen.
        </s-banner>
      )}

      {alerts.length === 0 ? (
        <s-section>
          <s-stack gap="small-200" alignItems="center">
            <s-heading>No alerts sent yet</s-heading>
            <s-paragraph color="subdued">
              Alerts are sent after a sync or inventory change pushes a variant
              past your alert level.
            </s-paragraph>
          </s-stack>
        </s-section>
      ) : (
        <s-section padding="none" accessibilityLabel="Alert history">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Alert</s-table-header>
              <s-table-header listSlot="inline">Delivery</s-table-header>
              <s-table-header>Variants</s-table-header>
              <s-table-header listSlot="labeled">Sent</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {alerts.map((a) => (
                <s-table-row key={a.id}>
                  <s-table-cell>
                    <s-stack gap="small-500">
                      <s-text>{a.subject}</s-text>
                      <s-text color="subdued">{`${a.channel === "EMAIL" ? "Email" : "SMS"} · ${a.recipient}`}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={a.delivered ? "success" : "warning"}>
                      {a.delivered ? "Delivered" : "Logged"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      {a.items.map((item) => (
                        <s-stack key={item.variantId} direction="inline" gap="small-200" alignItems="center">
                          <StatusBadge status={item.status} />
                          <s-link href={`/app/variants/${numericId(item.variantId)}`}>{item.title}</s-link>
                        </s-stack>
                      ))}
                      {a.itemCount > a.items.length && (
                        <s-text color="subdued">{`+${a.itemCount - a.items.length} more`}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{new Date(a.createdAt).toLocaleString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
