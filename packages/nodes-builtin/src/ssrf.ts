/**
 * Address classification for the SSRF guard of `ctx.http.fetch`, re-exported from
 * `@flowline/core` (where the design-time blocked-URL check shares it).
 *
 * @module
 */
export { isPrivateAddress } from "@flowline/core";
