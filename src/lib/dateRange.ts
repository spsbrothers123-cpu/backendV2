export function resolveRange(range: string, dateFrom?: string, dateTo?: string): { from: Date; to: Date } {
  const now = new Date();
  if (range === "custom" && dateFrom && dateTo) {
    return { from: new Date(dateFrom), to: new Date(dateTo) };
  }
  const to = now;
  const from = new Date(now);
  if (range === "today") from.setHours(0, 0, 0, 0);
  else if (range === "week") from.setDate(from.getDate() - 7);
  else if (range === "month") from.setDate(from.getDate() - 30);
  else from.setDate(from.getDate() - 1);
  return { from, to };
}
