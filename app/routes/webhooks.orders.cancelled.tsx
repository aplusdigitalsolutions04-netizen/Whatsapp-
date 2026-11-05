import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleOrderWebhook } from "../lib/order-webhook.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  await handleOrderWebhook(shop, topic, payload);
  return new Response(null, { status: 200 });
};
