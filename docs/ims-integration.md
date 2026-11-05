# IMS <-> WhatsApp bot integration

Two directions. Each has its own secret key, kept in `.env` of this project (never in git, never in chat).

| Direction | Key (in `.env`) | Who checks it |
|---|---|---|
| IMS sends a WhatsApp message through the bot | `IMS_API_KEY` | this project (`/api/send`) |
| The bot asks the IMS about an order | `IMS_LOOKUP_KEY` | the IMS (you must check it) |

## 1. IMS -> bot: send a message

```
POST https://<bot-host>/api/send
x-api-key: <IMS_API_KEY>
Content-Type: application/json

{ "to": "9876543210", "text": "Reminder: ...", "ref": "Billing - Contract 123" }
```

| Situation | Status | Body |
|---|---|---|
| Sent | 200 | `{"ok":true,"id":"..."}` |
| Wrong or missing key | 401 | `{"ok":false,"error":"Unauthorized"}` |
| WhatsApp not connected | 502 | `{"ok":false,"error":"WhatsApp is not connected ..."}` |
| Bad number / empty or too long text (max 1500) | 400 | error message |
| Bot uses the Cloud API instead of the QR connection | 501 | needs the QR connection |
| Too many requests (60/min per IP, 120/min total) | 429 | slow down |

`GET /api/send` with the same header tells whether WhatsApp is connected.
Send only a few messages a day to staff. The QR connection is unofficial and a number that sends too much can be banned.

## 2. Bot -> IMS: find an order

Set in the bot's `.env`:

```
IMS_BASE_URL=https://<ims-host>        # must be https (http only for localhost)
IMS_LOOKUP_KEY=<long random key, also configured in the IMS>
IMS_LOOKUP_PATH=/api/orders/lookup     # optional, this is the default
```

If `IMS_BASE_URL` or `IMS_LOOKUP_KEY` is missing the bot simply uses Shopify only.

The IMS must answer one `GET` endpoint, protected by the header `x-api-key: <IMS_LOOKUP_KEY>` (refuse anything else with 401):

```
GET <IMS_BASE_URL>/api/orders/lookup?phone=%2B919876543210     all orders of this customer phone (E.164, newest first, max 10)
GET <IMS_BASE_URL>/api/orders/lookup?order=1234                the order with this number (digits only)
```

Answer (200, JSON). No order found is NOT an error: return an empty list.

```json
{
  "ok": true,
  "orders": [
    {
      "name": "1234",
      "createdAt": "2026-11-01T10:30:00Z",
      "status": "Dispatched",
      "paymentStatus": "Paid",
      "total": "Rs. 12,500",
      "customerName": "Asha",
      "phones": ["+919876543210"],
      "items": [{ "title": "HP LaserJet", "quantity": 1, "sku": "HP-1020" }],
      "tracking": [{ "company": "Delhivery", "number": "DL123456789", "url": "https://..." }],
      "statusUrl": "https://..."
    }
  ]
}
```

Rules that keep customers safe:

* Always include `phones` (all phone numbers on the order). The bot shows an order only when the sender's WhatsApp number is one of them, even when the customer asked by order number.
* Use an error status (5xx) only when the IMS really could not look up. The bot then tells the customer to try again, and never says "you have no order" in that case.
* Answer within 6 seconds, otherwise the bot treats it as a failure.

## 3. What the customer sees

1. The bot searches the sender's number in Shopify and in the IMS at the same time.
2. Orders found: one order is shown directly; several are listed to pick from.
3. Nothing found: the bot asks for the order number.
4. The number is searched in both systems and must belong to the sender's phone. If it is found, the order is shown.
5. Not found anywhere (or it belongs to someone else): "we could not find any order for you". The wording is the same in both cases, so nothing about other people's orders is revealed.

## 4. Hosting notes

* One instance only (two copies logging in to the same WhatsApp number log each other out).
* Keep the `.wa-auth` folder, the SQLite file and `WHATSAPP_MEDIA_DIR` on persistent storage.
* The server must stay on and be served over HTTPS. If a proxy sits in front, it must forward `x-forwarded-for`.
* If a key leaks: change it in `.env`, restart, and give the new one to the other side.
