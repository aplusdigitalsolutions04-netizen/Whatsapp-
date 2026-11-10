import { test } from "node:test";
import assert from "node:assert/strict";
import { explainShopifyError } from "../app/lib/shopify-errors.ts";

test("Shopify failures are explained in plain words with the exact place to fix them", () => {
  assert.match(explainShopifyError("Access denied for phone field. ACCESS_DENIED"), /Protected Customer Data access.*Dev Dashboard/);
  assert.match(explainShopifyError("This app is not approved to access the Customer object."), /Protected Customer Data/);
  assert.match(explainShopifyError("No session found for shop x.myshopify.com"), /Open ShopPilot once from Shopify Admin/);
  assert.match(explainShopifyError("Received an error response (401 Unauthorized) from Shopify"), /rejected the saved access/);
  assert.match(explainShopifyError("Access denied for orders field. Required access: read_orders"), /Protected Customer Data/);
  assert.match(explainShopifyError("Throttled"), /busy/);
  assert.equal(explainShopifyError("Something odd   happened"), "Something odd happened");
  assert.equal(explainShopifyError(""), "Shopify did not answer.");
});
