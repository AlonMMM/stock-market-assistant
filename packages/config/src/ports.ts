import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Ports {
  web: number;
  api: number;
  e2eWeb: number;
  e2eApi: number;
}

export function getPorts(root = process.cwd(), env = process.env): Ports {
  const path = resolve(root, ".sma-session.json");
  const local = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const ports = {
    web: Number(env.SMA_WEB_PORT ?? local.ports?.web ?? 5173),
    api: Number(env.SMA_API_PORT ?? local.ports?.api ?? 3001),
    e2eWeb: Number(env.SMA_E2E_WEB_PORT ?? local.ports?.e2eWeb ?? 5174),
    e2eApi: Number(env.SMA_E2E_API_PORT ?? local.ports?.e2eApi ?? 3002),
  };
  for (const [name, port] of Object.entries(ports)) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error(
        `Invalid ${name} port; use an integer from 1024 to 65535.`,
      );
  }
  if (ports.web === ports.api || ports.e2eWeb === ports.e2eApi)
    throw new Error("Web and API ports must differ.");
  return ports;
}
