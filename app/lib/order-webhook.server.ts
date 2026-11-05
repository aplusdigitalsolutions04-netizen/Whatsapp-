/* eslint-disable @typescript-eslint/no-explicit-any */
import { logEvent } from "./log.server";
import { orderGid, syncOrderById } from "./order-sync.server";

/** Shared handler for order/fulfillment webhooks. Always answers 200: a miss is recovered by the scheduled sync. */
export async function handleOrderWebhook(shop: string, topic: string, payload: any) {
  try {
    const gid: string | undefined = payload?.admin_graphql_api_id;
    const id = gid?.startsWith("gid://shopify/Order/")
      ? gid
      : payload?.order_id
        ? orderGid(payload.order_id) // fulfillment topics carry the parent order id
        : payload?.id
          ? orderGid(payload.id)
          : null;
    if (!id) return;
    await syncOrderById(shop, id);
  } catch (e) {
    await logEvent({ shop, source: "shopify", level: "error", event: "order_webhook_failed", detail: `${topic}: ${(e as Error).message}` });
  }
}
