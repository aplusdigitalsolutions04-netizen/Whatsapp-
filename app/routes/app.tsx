import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import orderlyStyles from "../styles/orderly.css?url";
import dashboardStyles from "../styles/dashboard.css?url";
import { Shell } from "../components/Shell";
import { ClientOnly } from "../components/ui";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: orderlyStyles }, { rel: "stylesheet", href: dashboardStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [handoffs, errors] = await Promise.all([
    prisma.conversation.count({ where: { shop: session.shop, mode: "human", status: "open" } }),
    prisma.activityLog.count({ where: { level: "error", createdAt: { gte: since } } }),
  ]);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", shop: session.shop, handoffs, errors };
};

export default function App() {
  const { apiKey, shop, handoffs, errors } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <Shell data={{ shop, handoffs, errors }}>
        <ClientOnly><Outlet /></ClientOnly>
      </Shell>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
