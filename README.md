# RE+ 2026 Dining Holds — IT deployment guide

A small internal web app the Executive Office uses to track restaurant holds and reservations for the Terabase team at RE+ 2026 (Las Vegas, Nov 16–19). It also lists recommended restaurants two ways: **Near LVCC** (closest to the booth) and **Near a hotel** (meet a customer at or next to their hotel).

- **Requested by:** Linda Ramos (Executive Office)
- **Users:** about 10–40 Terabase staff. **A few editors** (Linda, plus anyone else invited, e.g. Ian); everyone else views only.
- **Lifetime:** event support, through late November 2026. It can be deleted afterward.

---

## Summary for IT

| Item | Choice |
|---|---|
| Hosting | **Azure Static Web Apps (Standard plan)**: a static front end plus a managed Azure Functions API (Node.js 22) |
| Data | **Azure Table Storage**: one table, about 30 rows today, a few hundred at most |
| Sign-in | **Microsoft Entra ID, Terabase tenant only**, using SWA built-in auth with a custom app registration |
| Access | Every page and API call requires sign-in. Writes require the SWA custom role **`editor`**, checked at the edge (route rules) and again in the API code |
| Infra as code | `infra/main.bicep` (SWA, Storage, Log Analytics, App Insights) |
| CI/CD | `.github/workflows/deploy.yml` (GitHub Actions). Azure DevOps or the SWA CLI also work |
| Build step | None. Plain HTML and JS; the API has 2 npm dependencies |
| Est. cost | About US$10–15/month (SWA Standard about $9 plus minimal storage and logging). Check current Azure pricing |

**Why Standard and not Free:** only the Standard plan supports a custom Entra ID registration. That's what limits sign-in to the Terabase tenant; the Free plan's built-in provider accepts any Microsoft account.

---

## Architecture

```
 Browser (staff, signed in with Terabase Entra ID)
    │  HTTPS
    ▼
 Azure Static Web Apps (Standard)
    ├─ /.auth/*                → built-in auth, Entra ID (single tenant)
    ├─ /                       → app/index.html + app/app.js   [role: authenticated]
    └─ /api/data/{coll}/{id}   → managed Azure Functions (Node 22)
          GET                  [role: authenticated]
          PUT/PATCH/DELETE     [role: editor] (reservations, nearby)
              │
              ▼
       Azure Table Storage  (table "dining"; PartitionKey = collection, RowKey = id)
       Application Insights (API logs and errors)
```

### Collections

| Collection | What it holds | Who writes |
|---|---|---|
| `reservations` | Holds and bookings: date, time, restaurant, host, party size, attendees, confirmation #, cancel-by deadline, notes | Editor, through the app |
| `nearby` | Restaurant list (57 places to start) with booking type, hours, phone and walk-time estimates | Editors, through the app (Add restaurant / Edit); initial load by seed script |
| `areas` | 5 neighborhood descriptions (Paradise Rd, Westgate, North Strip, The LINQ, LVCC) | IT/seed script only |

**Data classification:** Internal. Reservations contain staff and guest names, guest company names and the editor's sign-in email (audit field `updatedBy`). There is **no payment-card or financial-account data**; the form has no field for it. Please remind editors not to type card numbers into Notes.

---

## Repository layout

```
app/
  index.html                 page markup and styles
  app.js                     front-end logic (calls /api and /.auth/me)
  staticwebapp.config.json   auth provider, route/role rules, security headers
api/
  src/functions/data.js      HTTP API (one function, route data/{collection}/{id?})
  src/lib/auth.js            reads the SWA client principal and checks roles
  src/lib/store.js           Table Storage access (@azure/data-tables)
  src/lib/validate.js        field allow-list and length limits for writes
  test/api.test.js           unit tests (node --test), no Azure needed
  host.json, package.json, package-lock.json, local.settings.sample.json
infra/main.bicep             Azure resources
scripts/seed.js              loads seed/*.json into the table (adds new rows only; --overwrite restores)
scripts/load.sh              one-step load from Azure Cloud Shell (clone, install, read conn string, seed)
scripts/export.js            backs up all collections to JSON
seed/areas.json, seed/nearby.json   reference data
.github/workflows/deploy.yml CI/CD
```

---

## Deployment steps

### 1. Register the app in Entra ID

1. **Entra admin center → App registrations → New registration**
   - Name: `RE+ Dining Holds`
   - Supported account types: **Accounts in this organizational directory only (single tenant)**
   - Redirect URI (Web): `https://<swa-default-hostname>/.auth/login/aad/callback`. Add it after step 2 when the hostname is known, and also add the custom domain if you use one.
2. **Authentication:** enable **ID tokens**.
3. **Certificates & secrets:** create a client secret. Record its expiry; anything past early December 2026 covers the event.
4. *(Recommended)* **Enterprise applications → RE+ Dining Holds → Properties → Assignment required = Yes**, then assign the RE+ attendee group. This keeps the app limited to the people going.
5. Note the **Tenant ID**, **Application (client) ID** and **client secret**.

### 2. Create the Azure resources

```bash
az group create -n rg-replus-dining -l westus2
az deployment group create -g rg-replus-dining -f infra/main.bicep \
  -p aadClientId=<client-id> aadClientSecret=<client-secret>
```

Outputs: `siteUrl`, `staticWebAppName`, `storageAccountName`. The template sets these SWA app settings: `TABLES_CONNECTION_STRING`, `TABLE_NAME`, `AAD_CLIENT_ID`, `AAD_CLIENT_SECRET`, `APPLICATIONINSIGHTS_CONNECTION_STRING`.

Go back to the app registration and add the redirect URI using `siteUrl`.

### 3. Set the tenant in the SWA config

In `app/staticwebapp.config.json`, replace `<TENANT_ID>` in `openIdIssuer` with the Terabase tenant ID and commit the change.

### 4. Deploy the code

**Option A: GitHub Actions (included).** Push this folder to a repo, add the secret `AZURE_STATIC_WEB_APPS_API_TOKEN` (Static Web App → *Manage deployment token*), then push to `main`. The workflow runs the API tests and then deploys. Pull requests get an auth-protected staging URL. Until the secret is added, the workflow still runs the tests and skips the deploy steps, so it stays green.

**Option B: SWA CLI (no repo needed).**

```bash
npm install -g @azure/static-web-apps-cli
cd api && npm ci && cd ..
swa deploy ./app --api-location ./api --api-language node --api-version 22 \
  --env production --deployment-token <token>
```

**Option C: Azure DevOps.** Use the `AzureStaticWebApp@0` task with `app_location: app`, `api_location: api` and `skip_app_build: true`.

### 5. Load the restaurant data

```bash
cd api && npm ci && cd ..
TABLES_CONNECTION_STRING="<connection string from the SWA app settings>" node scripts/seed.js
# Loaded 9 areas
# Loaded 57 nearby
```

**Later data updates (no Azure access needed):** after new restaurants are merged into `seed/` and deployed, editors see a "＋ N new places ready" button at the top of the app. Tapping it adds only the missing places. Rows already in the table are never changed, and places removed in the app aren't offered again. It's backed by `api/src/functions/updates.js` and `api/src/lib/seedsync.js`, and the deploy workflow copies `seed/` into the API. Add new places to `seed/nearby.json` / `seed/areas.json` only. Changes to rows that are already live go in `seed/patches.json` under a new update name (each one is applied once). Update the seed files to match, so a fresh table gets the same result. `seed/baseline.json` lists what had already shipped before tracking began, so don't add new ids there.

The script is safe to re-run. By default it only adds rows that aren't in the table yet, so restaurants edited in the app are kept, and it follows the same rule as the in-app button, so places removed in the app don't come back. `--overwrite` replaces existing rows with the seed files (used for restores). It never touches `reservations` unless a `seed/reservations.json` file exists.

### 6. Give editors the editor role

Repeat for each editor (Linda, `lramos@terabase.energy`, plus anyone else who should edit, such as Ian):

**Static Web App → Role management → Invite**
- Authentication provider: **Microsoft Entra ID**
- Invitee: the editor's Terabase email
- Domain: the site's hostname
- Role: **`editor`**

Send each editor their invitation link. They accept it once while signed in, and from then on see **+ Add booking**, **+ Add restaurant**, Edit and Delete. Everyone else signs in and gets view-only access automatically; no invitation is needed. Several editors can work at once: if two people edit the same item, the second save is refused with a "someone else changed this" message instead of overwriting the first.

*Alternative:* if you'd rather manage editors through an Entra group, use SWA's `rolesSource` function to map a group to `editor`. That isn't included here.

### 7. Custom domain: `redine.terabase.energy`

1. **DNS** (whoever manages `terabase.energy`): add a CNAME record `redine` → the SWA default hostname (for example `nice-island-08ba0641e.3.azurestaticapps.net`).
2. **Attach it** once the CNAME resolves (Azure validates it):
   ```bash
   az staticwebapp hostname set -n replusdining-swa -g rg-replus-dining --hostname redine.terabase.energy
   ```
   Azure issues and renews the TLS certificate automatically.
3. **Sign-in:** add `https://redine.terabase.energy/.auth/login/aad/callback` to the app registration's redirect URIs (keep the default one too).
4. *(Optional)* In **Static Web App → Custom domains**, set `redine.terabase.energy` as the default domain.

### 7b. Google Maps key for the map popup

The restaurant map popup uses Google's official **Maps Embed API** when the site has a key; without one it falls back to Google's keyless embed (undocumented, may not load). The Embed API is free with no usage limit, but Google requires a billing account on the project.

1. [Google Cloud console](https://console.cloud.google.com/) → create a project (e.g. `REdine`) and attach a billing account.
2. **APIs & Services → Library** → enable **Maps Embed API**.
3. **APIs & Services → Credentials → Create credentials → API key**, then edit the key:
   - **Application restrictions:** Websites → `https://redine.terabase.energy/*` and `https://nice-island-08ba0641e.3.azurestaticapps.net/*`
   - **API restrictions:** Restrict key → **Maps Embed API** only
4. Save it as an app setting (the hidden prompt keeps it out of shell history):
   ```bash
   read -s "KEY?Maps Embed API key (hidden): "; echo
   az staticwebapp appsettings set -n replusdining-swa -g rg-replus-dining \
     --setting-names GOOGLE_MAPS_EMBED_KEY="$KEY" -o none; unset KEY
   ```
   If you later re-run `infra/main.bicep`, pass `mapsEmbedKey=<key>` too: the template replaces all app settings.

The key is a browser key: it is served to signed-in users by `GET /api/config` and appears in the map iframe URL, so the website and API restrictions above are what protect it.

### 8. Smoke test

- [ ] Opening the site in a private window redirects to Microsoft sign-in, and only Terabase accounts can sign in.
- [ ] A regular user sees "View only", with no Add/Edit/Delete buttons.
- [ ] A regular user calling `PUT /api/data/reservations/test` (for example from browser dev tools) gets **403**.
- [ ] An editor sees "You can edit", adds a test hold, changes its status and deletes it.
- [ ] The **search box** finds restaurants by name, hotel or food, and bookings by restaurant, host or guest. Typing a hotel name offers a "Near <hotel> →" shortcut.
- [ ] The **Places** tab has two buttons. **Near LVCC** lists the closest places first. **Near a hotel** has you pick the customer's hotel, then shows places *At* that hotel and *Next door*. Each card has **Book / Call / Map** buttons, and **Map** (or tapping a name) opens a map with the route from Central Hall or The LINQ.
- [ ] **+ Add booking**: picking a restaurant fills in its area and walk time; pick a day, time, party size and save. The **Bookings** tab shows it, and "Just mine" filters to bookings you host.
- [ ] An editor adds a test restaurant with **+ Add restaurant**, edits it, then removes it.
- [ ] Export CSV downloads a file.
- [ ] App Insights shows API requests.

---

## Local development

```bash
npm install -g azurite @azure/static-web-apps-cli azure-functions-core-tools@4
azurite-table --inMemoryPersistence &
cp api/local.settings.sample.json api/local.settings.json
cd api && npm ci && cd ..
TABLES_CONNECTION_STRING="UseDevelopmentStorage=true" node scripts/seed.js
swa start app --api-location api      # http://localhost:4280 (mock sign-in; add role "editor" there)
```

Unit tests: `cd api && npm test` (10 tests; no Azure resources needed).

---

## Security notes

- **Authentication** happens at the SWA edge. Every route, including `/api/*`, requires the `authenticated` role, and unauthenticated requests redirect to Entra sign-in. GitHub and Twitter login routes are disabled.
- **Authorization** is enforced twice. SWA route rules limit `PUT`, `PATCH` and `DELETE` on `/api/data/reservations/*` and `/api/data/nearby/*` to `editor`, and the API checks the role again from the `x-ms-client-principal` header (which SWA sets and clients cannot forge). `areas` can't be written through the API at all.
- **Input validation:** writes accept only an allow-list of fields per collection (reservations, restaurants) with length limits; restaurant booking types and meals must come from fixed lists. IDs must match `^[A-Za-z0-9_-]{1,64}$`, links must be http(s), and bodies are capped at 32 KB. The front end escapes all data before rendering.
- **Headers:** CSP (`script-src 'self'`, no inline scripts, no third-party connections), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and `frame-ancestors 'none'`. The page also sets `noindex`.
- **Secrets:** the storage connection string, Entra client secret and Google Maps browser key live only in SWA app settings, which are encrypted at rest; they are not in the repo. *Trade-off:* SWA managed functions don't support managed identity, so a storage key is used. If your policy requires managed identity or Key Vault references, deploy the API as a separate Function App with managed identity and link it to the SWA ("bring your own functions"). The code works unchanged; only the connection setup differs.
- **External resources:** Google Fonts (Inter and Chivo Mono, the brand web fonts) and an embedded Google Maps frame in the restaurant map popup (CSP `frame-src` allows only `www.google.com` and `maps.google.com`; it is loaded only when someone opens a map, and it sees only the public restaurant and LVCC addresses). If the embed stops working, the popup's **Open in Google Maps** link still works. To remove it, self-host the fonts or delete the `<link>` tags; the page falls back to Arial, the brand's system-font substitute.

## Branding

Styled to the Terabase Brand Guidelines (2023): navy `#1B3359` header, orange `#F75200` accents, Inter / Chivo Mono type. Text colors are shades of the brand palette chosen to meet WCAG AA contrast in light and dark mode (tokens and notes are at the top of `app/index.html`).

Logo files are in `app/brand/`, exported from SharePoint (*TB Docs → 04. Sales & Marketing → LOGO → Terabase Logo*):

| File in `app/brand/` | SharePoint source |
|---|---|
| `terabase-logo-white.png` | `Primary/Partial White/Terabase_Primary_Logo_Partial_White.png` (color mark, white wordmark, for the navy header) |
| `terabase-mark.png` | `Icon Mark/Full Color/Terabase_Icon_Mark_Full_Color.png` (browser tab icon) |

If a file is missing the page simply hides the logo.

**Phones:** the layout is built for phones first (checked at 320–430px wide): finger-sized buttons (~44px), 16px text in fields so iPhones don't zoom in, and room for the notch. People can use **Share → Add to Home Screen** (iPhone) or **Install app** (Android) to get a REdine icon that opens full-screen; `app/manifest.webmanifest` and the `app/brand/icon-*.png` / `apple-touch-icon.png` files (generated from the icon mark) drive that. `/brand/*` and the manifest are the only paths served without sign-in, because phones fetch home-screen icons without the login cookie.
- **Rotation:** rotate the storage key and client secret after the event, or simply delete the resource group.

## Operations, backup and rollback

- **Monitoring:** API logs and errors go to Application Insights (`<prefix>-ai`). Writes are logged as `PUT|PATCH|DELETE reservations/<id> by <user>`.
- **Backup:** Table Storage has no point-in-time restore. Run `node scripts/export.js` (with `TABLES_CONNECTION_STRING` set) before the event, nightly during show week if you want, and after the event. It writes `backup-<timestamp>/*.json`.
- **Data restore:** copy the backup files into `seed/` and run `node scripts/seed.js --overwrite`.
- **Code rollback:** redeploy the previous commit (`git revert` and push, or run `swa deploy` from the previous version). Data is unaffected.
- **Decommission (after Nov 2026):** run `export.js`, give Linda the CSV or JSON, then `az group delete -n rg-replus-dining` and delete the app registration.

## Known limitations

- **Edit conflicts** are detected, not merged. Each document carries its Table Storage ETag; edits and deletes send it as `If-Match`, and a stale one gets 412 and a "someone else changed this" message. Quick status changes from the dropdown merge just that field.
- **Updates across devices** arrive by polling every 30 seconds, not instantly.
- **Restaurant details** (hours, booking policies, walk times) were researched in October 2026 and are estimates. Editors can correct them in the app (Edit on any restaurant card). `seed/*.json` is only the starting list.
- **No email or calendar integration.** It's a tracker only; bookings are still made on OpenTable or by phone.

## Questions for IT to decide

1. GitHub vs Azure DevOps for the repo and pipeline.
2. Whether to require app assignment (step 1.4) and which group to use.
3. Whether the storage-key setup is acceptable or managed identity is required (see Security notes).
4. Custom domain name, if any.
5. Region (default `westus2`) and naming or tagging conventions. Adjust the `prefix` and `tags` parameters.

---

*Origin:* this is a port of a prototype Linda built in Claude (claude.ai). The front end is the same app with its data layer moved from the Claude-hosted store to this API. The reference data in `seed/` was exported from the prototype on 2026-10-13 (28 restaurants after the Oct 13 additions; Loco Bueno Tacos was later removed because it is closed Mon–Wed of show week). There were no reservations to migrate yet.
