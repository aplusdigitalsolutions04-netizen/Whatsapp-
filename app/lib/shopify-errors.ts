/**
 * Turns the raw text of a failed Shopify call into one plain sentence the store owner can act on.
 * Shown on the dashboard and on the Integrations page, never to customers.
 */
export function explainShopifyError(raw: string): string {
  const msg = String(raw ?? "");
  if (/protected customer data|not approved to access|ACCESS_DENIED|access denied/i.test(msg)) {
    return "Shopify is blocking customer and order details because this app has no Protected Customer Data access. Open the Dev Dashboard > ShopPilot > API access > Protected customer data access, enable it (Customer, Name, Email, Phone, Address), save, release a new version and open the app again.";
  }
  if (/could not find a session|no session|session not found|offline session/i.test(msg)) {
    return "The app has not signed in to this store yet. Open ShopPilot once from Shopify Admin > Apps, then try again.";
  }
  if (/401|unauthori[sz]ed|invalid api key or access token|access token/i.test(msg)) {
    return "Shopify rejected the saved access. Open ShopPilot once from Shopify Admin > Apps to refresh it. If that does not help, uninstall and install the app again.";
  }
  if (/read_orders|read_customers|read_products|required access|missing.*scope|scope/i.test(msg)) {
    return `A permission is missing for the app (${msg.replace(/\s+/g, " ").slice(0, 160)}). Re-install the app and accept all permissions.`;
  }
  if (/throttl|429/i.test(msg)) return "Shopify is busy right now (rate limit). Try again in a minute.";
  return msg.replace(/\s+/g, " ").slice(0, 240) || "Shopify did not answer.";
}
