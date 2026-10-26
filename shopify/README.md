# Shopify Bridge

A standalone Google Apps Script Web App that lets the admin create/update Shopify
products. Kept separate from `Code.gs` so the existing site backend (stock, orders,
logins) is never at risk.

## Deploy (once)

1. script.google.com → **New project** → name it `Shopify Bridge`
2. Paste `ShopifyBridge.gs`, Save
3. **Project Settings → Script Properties**, add:

   | Property | Value |
   |---|---|
   | `SHOP` | `romankenojewelry.myshopify.com` |
   | `CLIENT_ID` | the Shopify custom app client id (**not stored in this repo**) |
   | `CLIENT_SECRET` | the Shopify custom app client secret (**not stored in this repo**) |
   | `BRIDGE_KEY` | any long random string you invent |

4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the `/exec` URL into `admin.html` (`SHOPIFY_BRIDGE_URL`)

## Why the credentials live in Script Properties

`admin.html` is served publicly from GitHub Pages. A Shopify Admin API token in that
file would be readable by anyone. The bridge holds them server-side; the browser only
ever sends the `BRIDGE_KEY`.

## Actions

| Action | Purpose |
|---|---|
| `ping` | health check, returns the shop name |
| `listProducts` | product list for the admin panel |
| `pushListing` | create/update a product from a listing, attach images, set stock, add to collections |

Products are matched by **handle** (slug of the title), so re-pushing the same listing
updates it instead of duplicating.
