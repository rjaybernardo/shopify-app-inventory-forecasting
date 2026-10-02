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
import { getSettings, recompute } from "../services/forecast.server";
import { emailProvider, sendEmail, sendSms, smsProvider } from "../services/notify.server";
import { STATUS_META } from "../lib/forecast";

const NUMBER_FIELDS = {
  lookbackDays: { min: 7, max: 60, label: "Sales lookback" },
  leadTimeDays: { min: 0, max: 365, label: "Supplier lead time" },
  safetyStockDays: { min: 0, max: 180, label: "Safety stock" },
  warningDays: { min: 0, max: 180, label: "Early warning" },
  coverageDays: { min: 1, max: 365, label: "Reorder coverage" },
  remindAfterDays: { min: 1, max: 60, label: "Reminder interval" },
} as const;
type NumberField = keyof typeof NUMBER_FIELDS;

const ALERT_LEVELS = ["OUT_OF_STOCK", "CRITICAL", "REORDER", "WATCH"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return {
    settings: await getSettings(session.shop),
    emailProvider: emailProvider(),
    smsProvider: smsProvider(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const settings = await getSettings(shop);

  if (form.get("intent") === "test") {
    const sent: string[] = [];
    if (settings.alertEmail) {
      await sendEmail(
        settings.alertEmail,
        "Test alert from Inventory Forecasting",
        "<p>Stock alerts for your store will arrive at this address.</p>",
      );
      sent.push("email");
    }
    if (settings.alertPhone) {
      await sendSms(settings.alertPhone, "Test alert from Inventory Forecasting.");
      sent.push("SMS");
    }
    return sent.length
      ? { ok: true, message: `Test ${sent.join(" & ")} sent` }
      : { ok: false, message: "Save an email or phone number first" };
  }

  const numbers = {} as Record<NumberField, number>;
  for (const [key, rule] of Object.entries(NUMBER_FIELDS) as [NumberField, (typeof NUMBER_FIELDS)[NumberField]][]) {
    const n = Math.round(Number(form.get(key)));
    if (!Number.isFinite(n) || n < rule.min || n > rule.max) {
      return { ok: false, message: `${rule.label} must be between ${rule.min} and ${rule.max} days` };
    }
    numbers[key] = n;
  }

  const alertLevel = String(form.get("alertLevel"));
  const alertEmail = String(form.get("alertEmail") ?? "").trim() || null;
  const alertPhone = String(form.get("alertPhone") ?? "").replace(/[^\d+]/g, "") || null;
  const emailEnabled = form.get("emailEnabled") === "on";
  const smsEnabled = form.get("smsEnabled") === "on";

  if (!(ALERT_LEVELS as readonly string[]).includes(alertLevel)) {
    return { ok: false, message: "Choose when to alert" };
  }
  if (emailEnabled && !alertEmail) return { ok: false, message: "Add an email address for alerts" };
  if (smsEnabled && !alertPhone?.startsWith("+")) {
    return { ok: false, message: "Use an international phone number, e.g. +15551234567" };
  }

  await db.shopSettings.update({
    where: { shop },
    data: {
      ...numbers,
      alertLevel,
      alertEmail,
      alertPhone,
      emailEnabled,
      smsEnabled,
      // A longer window needs older orders, so force a full backfill on next sync.
      ...(numbers.lookbackDays > settings.lookbackDays ? { lastOrderSyncAt: null } : {}),
    },
  });
  await recompute(shop);

  return {
    ok: true,
    message:
      numbers.lookbackDays > settings.lookbackDays
        ? "Saved. Sync to backfill the longer window."
        : "Settings saved and forecasts updated",
  };
};

export default function Settings() {
  const { settings, emailProvider, smsProvider } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const num = (name: NumberField, details: string) => (
    <s-number-field
      label={`${NUMBER_FIELDS[name].label} (days)`}
      name={name}
      min={NUMBER_FIELDS[name].min}
      max={NUMBER_FIELDS[name].max}
      defaultValue={String(settings[name])}
      details={details}
    />
  );

  return (
    <s-page heading="Settings">
      <fetcher.Form method="post">
        <s-section heading="Forecast thresholds">
          <s-stack gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
              {num("leadTimeDays", "Days from placing a purchase order to receiving stock.")}
              {num("safetyStockDays", "Buffer kept on hand for demand spikes and late deliveries.")}
              {num("warningDays", "Flag variants as Watch this many days before the reorder point.")}
              {num("coverageDays", "How many days of sales each reorder should cover.")}
              {num("lookbackDays", "Sales history used for velocity. Shopify shares the last 60 days of orders.")}
            </s-grid>
            <s-text color="subdued">
              Lead time and safety stock can be overridden per variant from its forecast page.
            </s-text>
          </s-stack>
        </s-section>

        <s-section heading="Alerts">
          <s-stack gap="base">
            <s-select label="Alert me when a variant is" name="alertLevel" value={settings.alertLevel}>
              {ALERT_LEVELS.map((level) => (
                <s-option key={level} value={level}>
                  {`${STATUS_META[level].label} or worse`}
                </s-option>
              ))}
            </s-select>
            {num("remindAfterDays", "Re-send an alert for a variant that is still at risk after this long.")}
            <s-divider />
            <s-checkbox label="Email alerts" name="emailEnabled" defaultChecked={settings.emailEnabled} />
            <s-email-field
              label="Email address"
              name="alertEmail"
              defaultValue={settings.alertEmail ?? ""}
            />
            <s-checkbox label="SMS alerts" name="smsEnabled" defaultChecked={settings.smsEnabled} />
            <s-text-field
              label="Mobile number"
              name="alertPhone"
              placeholder="+15551234567"
              defaultValue={settings.alertPhone ?? ""}
              details="International format. Alerts are batched into one message per sync."
            />
            <s-stack direction="inline" gap="small-200">
              <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
                Save
              </s-button>
              <s-button
                onClick={() => fetcher.submit({ intent: "test" }, { method: "POST" })}
                disabled={busy}
              >
                Send test alert
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </fetcher.Form>

      <s-section slot="aside" heading="Delivery">
        <s-stack gap="small-300">
          <s-stack direction="inline" justifyContent="space-between">
            <s-text>Email</s-text>
            <s-badge tone={emailProvider ? "success" : "warning"}>{emailProvider ?? "Log only"}</s-badge>
          </s-stack>
          <s-stack direction="inline" justifyContent="space-between">
            <s-text>SMS</s-text>
            <s-badge tone={smsProvider ? "success" : "warning"}>{smsProvider ?? "Log only"}</s-badge>
          </s-stack>
          <s-text color="subdued">
            Set RESEND_API_KEY for email and TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
            TWILIO_FROM for SMS. Without them, alerts are written to the server log.
          </s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Statuses">
        <s-stack gap="small-300">
          {Object.entries(STATUS_META).map(([key, meta]) => (
            <s-stack key={key} gap="small-500">
              <s-badge tone={meta.tone}>{meta.label}</s-badge>
              <s-text color="subdued">{meta.help}</s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
