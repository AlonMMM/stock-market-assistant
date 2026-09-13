export interface HealthResponse {
  status: "ok";
  service: "stock-market-assistant";
  marketData: "not-connected";
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  return (
    "status" in value &&
    value.status === "ok" &&
    "service" in value &&
    value.service === "stock-market-assistant" &&
    "marketData" in value &&
    value.marketData === "not-connected"
  );
}
