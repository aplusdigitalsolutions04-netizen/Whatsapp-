import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getWaiting } from "../lib/waiting.server";

// Polled every few seconds by the support alert in the app shell (resource route: no page of its own).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { waiting: await getWaiting(session.shop) };
};
