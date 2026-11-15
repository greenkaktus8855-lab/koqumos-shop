# Koqumo’s Shop

A small Ukrainian storefront built with plain HTML/CSS/JS, Cloudflare Workers and Cloudflare D1. The `koqumos-shop` branch contains this project independently; the repository's `main` branch is unchanged.

## Included

- Responsive storefront and product catalogue.
- Search, categories, sorting, cart and checkout.
- Product management: create, edit, delete, price, stock and percentage discounts.
- Order dashboard with status management.
- Nova Poshta city and warehouse lookup through the official API.
- Admin action to create an electronic waybill (ТТН) through Nova Poshta API 2.0.
- Password-protected admin session using an HttpOnly, Secure, SameSite cookie.
- Product stock is reserved when an order is accepted.

## Deploy to Cloudflare Workers

1. Clone this branch and install dependencies:

   ```bash
   npm install
   ```

2. Create the D1 database:

   ```bash
   npx wrangler d1 create koqumos-shop-db
   ```

3. Copy the `database_id` from Wrangler's output into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

4. Apply the schema to the remote database:

   ```bash
   npx wrangler d1 migrations apply koqumos-shop-db --remote
   ```

5. Add server-side secrets. Do not put these values in HTML, JavaScript, GitHub files, or `.dev.vars` committed to Git:

   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put NOVA_POSHTA_API_KEY
   ```

   `SESSION_SECRET` should be a long, random value. Keep the admin password private.

6. Deploy:

   ```bash
   npx wrangler deploy
   ```

Cloudflare Workers Static Assets serves the HTML/CSS/JS while the Worker handles `/api/*`. D1 stores products, stock, orders and sender settings.

## Connect Nova Poshta

- Generate an API key in the Nova Poshta business account (Settings → Security → Create key). Nova Poshta documents API 2.0 for online-store integrations and creating electronic waybills; the API entry point is `https://api.novaposhta.ua/v2.0/json/`.
- Add the key only as the Cloudflare secret `NOVA_POSHTA_API_KEY`.
- Sign in to the shop admin panel → **Нова пошта** and add the sender's City Ref, Sender Ref, Sender Address Ref, Contact Person Ref, phone and parcel weight.
- The checkout uses the API to search cities and branches. An admin can then create a real waybill for an order. Nova Poshta returns the ТТН number, which is saved to the order.

Nova Poshta API access and sender account permissions are controlled by Nova Poshta. The exact sender references must belong to the account connected to the API key. A live ТТН cannot be tested until the owner supplies a valid key and sender references.

## Important before accepting real orders

- This project does not include online card payments. The checkout currently offers cash-on-delivery or payment by arrangement with the shop owner.
- The shop stores customer name, phone number and selected delivery branch in D1 so the order can be fulfilled. Publish a clear privacy notice and only collect information needed for orders.
- Before accepting real orders or managing customer data, have a parent/guardian review the shop, the Nova Poshta account and the privacy/consumer requirements with you.
- Test the full flow with a test product and a permitted test shipment before public launch.

## Local development

After setting the D1 database ID and adding local values to an untracked `.dev.vars` file, run:

```bash
npx wrangler d1 migrations apply koqumos-shop-db --local
npx wrangler dev
```

Example `.dev.vars` (never commit it):

```dotenv
ADMIN_PASSWORD="change-this-to-a-private-password"
SESSION_SECRET="use-a-long-random-secret"
NOVA_POSHTA_API_KEY="your-nova-poshta-api-key"
```

## Main files

- `public/index.html` — page structure and forms.
- `public/styles.css` — responsive design.
- `public/app.js` — catalogue, cart, checkout and admin interface.
- `src/index.js` — API, admin authentication and Nova Poshta integration.
- `migrations/0001_init.sql` — D1 schema.
- `wrangler.jsonc` — Worker, assets and D1 configuration.
