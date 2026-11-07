/**
 * The browser-safe part of the gateway: schemas and pure planning code, no Node modules.
 * The UI (through @depo/shared) imports this, so the Vite dev server never sees node:http or node:stream.
 */
export * from "./autofit";
export * from "./catalog";
export * from "./hardware";
