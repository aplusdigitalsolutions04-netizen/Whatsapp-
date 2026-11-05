import { gql } from "../shopify-data.server";
import type { Ctx } from "./shopify-images.server.ts";

/** The real Shopify connection for one shop (kept out of the tested files so they never need a login). */
export const shopifyCtx = (shop: string): Ctx => ({ shop, gql: (query, variables) => gql(shop, query, variables ?? {}) });
