/**
 * The local development API: an HTTP adapter over `@lexicue/core`.
 *
 * Nothing here decides what anything costs or what state an upload is in. The
 * server reads requests and writes responses, the store keeps the core's rows
 * in a JSON file and its bytes on disk, and the links stand in for presigned S3
 * GETs. Phase 2 replaces all three with a Lambda, DynamoDB and S3 and keeps the
 * core untouched.
 */
export { createDevApi, type DevApi, type DevApiOptions } from "./server.js";
export { DevStore, STATE_VERSION, defaultStateDir, type DevSnapshot } from "./store.js";
export { DOWNLOAD_TTL_MS, DownloadLinks } from "./links.js";
export { DEFAULT_API_PORT, missingKeyMessage, resolveApiKey } from "./env.js";
