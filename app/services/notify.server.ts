// Outbound notifications. Email goes through Resend and SMS through Twilio when
// their credentials are set; otherwise messages are logged so the flow is
// observable in development.

export const emailProvider = () => (process.env.RESEND_API_KEY ? "Resend" : null);
export const smsProvider = () =>
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM
    ? "Twilio"
    : null;

export async function sendEmail(to: string, subject: string, html: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email] to=${to} subject="${subject}"`);
    return false;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || "Stock Alerts <alerts@example.com>",
        to,
        subject,
        html,
      }),
    });
    if (!response.ok) {
      console.error(`[email] Resend error ${response.status}: ${await response.text()}`);
    }
    return response.ok;
  } catch (error) {
    // Alerts must never break a sync or a webhook.
    console.error("[email] send failed", error);
    return false;
  }
}

export async function sendSms(to: string, body: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    console.log(`[sms] to=${to} body="${body}"`);
    return false;
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
      },
    );
    if (!response.ok) {
      console.error(`[sms] Twilio error ${response.status}: ${await response.text()}`);
    }
    return response.ok;
  } catch (error) {
    console.error("[sms] send failed", error);
    return false;
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
