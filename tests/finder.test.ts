import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, matchCatalog } from "../app/lib/finder/match.ts";
import { htmlToPlain, linkKey, listingAmazon, listingGeneric, makeSku, money, num, parseDetail } from "../app/lib/finder/parse.ts";

const catalog = [
  { id: "1", title: "HP LaserJet 1008a Monochrome Single Function Printer Combo", handle: "hp-laserjet-1008a", vendor: "WERY", skus: ["HP-1008A"], barcodes: [] },
  { id: "2", title: "HP 250R G10 Intel Core 3 100U Laptop Combo", handle: "hp-250r", vendor: "WERY", skus: [], barcodes: ["8901234567890"] },
  { id: "3", title: "Men's Canvas Runner NZ - Deep Navy Stripes", handle: "canvas-runner", vendor: "NZ", skus: [], barcodes: [] },
  { id: "4", title: "Apple iPhone 14 128GB Blue", handle: "iphone-14", vendor: "Apple", skus: [], barcodes: [] },
];
const idx = buildIndex(catalog);

test("catalog match: same product is found, different model is not", () => {
  assert.match(matchCatalog(idx, { title: "HP LaserJet 1008a Monochrome Printer" })?.reason ?? "", /Similar name/);
  assert.ok(matchCatalog(idx, { title: "HP 250R G10 Intel Core 3 100U Laptop" }));
  assert.ok(matchCatalog(idx, { title: "Canvas Runner NZ Men's Deep Navy Stripes" }));
  // other model numbers must never count as "already in store"
  assert.equal(matchCatalog(idx, { title: "HP LaserJet 1010 Monochrome Single Function Printer Combo" }), null);
  assert.equal(matchCatalog(idx, { title: "Apple iPhone 15 128GB Blue" }), null);
  assert.equal(matchCatalog(idx, { title: "Nike Air Zoom Running Shoes" }), null);
});

test("catalog match: SKU or barcode is decisive", () => {
  assert.match(matchCatalog(idx, { title: "Totally different title", skus: ["hp-1008a"] })?.reason ?? "", /SKU/);
  assert.match(matchCatalog(idx, { title: "Something else", barcodes: ["8901234567890"] })?.reason ?? "", /SKU\/barcode/);
  assert.equal(matchCatalog(idx, { title: "Something else", skus: ["X1"] }), null);
});

test("prices and links", () => {
  assert.equal(num("₹1,499.00"), 1499);
  assert.equal(num("no price"), null);
  assert.equal(money("2499", "INR"), "₹2,499");
  assert.equal(linkKey("https://www.example.com/products/shoe/?utm=1#x"), "example.com/products/shoe");
});

test("detail page: JSON-LD product with sale price and stock", () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "Product", name: "Trail Shoe", brand: { name: "Acme" }, image: ["https://cdn.x.com/a.jpg", "https://cdn.x.com/b.jpg"],
    offers: { "@type": "Offer", price: "1499", priceCurrency: "INR", availability: "https://schema.org/InStock" },
  })}</script></head><body><del>₹1,999</del></body></html>`;
  const d = parseDetail(html, "https://shop.example.com/products/trail-shoe");
  assert.equal(d.title, "Trail Shoe");
  assert.equal(d.brand, "Acme");
  assert.equal(d.price, "₹1,499");
  assert.equal(d.comparePrice, "₹1,999");
  assert.equal(d.inStock, true);
  assert.deepEqual(d.images, ["https://cdn.x.com/a.jpg", "https://cdn.x.com/b.jpg"]);
  const out = parseDetail(html.replace("InStock", "OutOfStock"), "https://shop.example.com/products/trail-shoe");
  assert.equal(out.inStock, false);
});

test("detail page: Amazon price, availability, brand and hi-res images", () => {
  const html = `<span id="productTitle"> Acme Running Shoes </span>
    <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">₹1,299</span></span>
    <span class="a-price a-text-price"><span class="a-offscreen">₹1,999</span></span></div>
    <input id="add-to-cart-button"><a id="bylineInfo">Visit the Acme Store</a>
    <script>var data = {"hiRes":"https://m.media-amazon.com/images/I/abc._AC_SL1500_.jpg"}</script>`;
  const d = parseDetail(html, "https://www.amazon.in/dp/B012345678");
  assert.equal(d.title, "Acme Running Shoes");
  assert.equal(d.price, "₹1,299");
  assert.equal(d.comparePrice, "₹1,999");
  assert.equal(d.inStock, true);
  assert.equal(d.brand, "Acme");
  assert.equal(d.images.length, 1);
});

test("SKU is BRAND-MODEL and the description is plain text", () => {
  assert.equal(makeSku("HP", "HP 15 Laptop 126snw 16GB RAM 512GB SSD"), "HP-126snw");
  assert.equal(makeSku("Dell Inc", "Dell Inspiron 3520 Intel Core i5", "3520-i5"), "DELL-3520-i5");
  assert.equal(makeSku("", "Acme Trail Shoe"), "ACME-Trail-Shoe");
  assert.equal(makeSku("Sony", "Sony WH-1000XM5 Wireless Headphones"), "SONY-WH-1000XM5");
  assert.equal(makeSku("", ""), "ITEM");
  assert.equal(htmlToPlain("<p>Fast&nbsp;laptop</p><ul><li>16GB RAM</li><li>SSD</li></ul>"), "Fast laptop\n16GB RAM\nSSD");
  const d = parseDetail(`<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "X", description: "<b>Great</b> value", model: "ZX-9", offers: { price: "10" } })}</script>`, "https://a.example.com/p/x");
  assert.equal(d.description, "Great value");
  assert.equal(d.model, "ZX-9");
});

test("search listings: Amazon results and generic product links", () => {
  const amazon = `<div data-component-type="s-search-result"><h2><a href="/Acme-Shoe/dp/B012345678/ref=x">Acme Running Shoe</a></h2></div>`;
  assert.deepEqual(listingAmazon(amazon, "https://www.amazon.in"), [{ title: "Acme Running Shoe", link: "https://www.amazon.in/dp/B012345678" }]);
  const generic = `<a href="/products/blue-kurta-cotton">Blue Cotton Kurta Set</a><a href="/about">About us page</a>`;
  assert.deepEqual(listingGeneric(generic, "https://site.com"), [{ title: "Blue Cotton Kurta Set", link: "https://site.com/products/blue-kurta-cotton" }]);
});
