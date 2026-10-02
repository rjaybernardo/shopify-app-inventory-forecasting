import { STATUS_META, type Status } from "../lib/forecast";

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status as Status];
  if (!meta) return <s-badge>{status}</s-badge>;
  return <s-badge tone={meta.tone}>{meta.label}</s-badge>;
}
