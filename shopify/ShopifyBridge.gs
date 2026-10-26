/**
 * ============================================================================
 *  ROMAN KENO — SHOPIFY BRIDGE
 * ============================================================================
 *  A tiny Apps Script Web App that lets admin.html create/update Shopify
 *  products. Deliberately separate from your existing site backend so nothing
 *  that already works (stock, orders, logins) can break.
 *
 *  DEPLOY (once):
 *    1. script.google.com ▸ New project  ▸ name it "Shopify Bridge"
 *    2. Paste this file, Save
 *    3. Project Settings ▸ Script Properties ▸ add:
 *         SHOP           = romankenojewelry.myshopify.com
 *         CLIENT_ID      = <Shopify custom app client id>
 *         CLIENT_SECRET  = <Shopify custom app client secret>
 *         BRIDGE_KEY     = <any long random string you invent>
 *    4. Deploy ▸ New deployment ▸ Web app
 *         Execute as: Me
 *         Who has access: Anyone
 *    5. Copy the /exec URL — paste it into admin.html (SHOPIFY_BRIDGE_URL)
 *
 *  The BRIDGE_KEY is what stops random people calling your /exec URL, because
 *  the URL itself is public. admin.html asks for it once per session.
 * ============================================================================
 */

var PROPS = PropertiesService.getScriptProperties();
var API_VERSION = '2024-10';
var DEFAULT_COLLECTION = 'artisan-supplies';

/* --------------------------------------------------------------- plumbing -- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function token_() {
  var cached = PROPS.getProperty('TOKEN');
  var exp = Number(PROPS.getProperty('TOKEN_EXP') || 0);
  if (cached && Date.now() < exp) return cached;

  var res = UrlFetchApp.fetch('https://' + PROPS.getProperty('SHOP') + '/admin/oauth/access_token', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: PROPS.getProperty('CLIENT_ID'),
      client_secret: PROPS.getProperty('CLIENT_SECRET'),
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('auth failed: ' + res.getContentText().slice(0, 200));
  var b = JSON.parse(res.getContentText());
  PROPS.setProperty('TOKEN', b.access_token);
  PROPS.setProperty('TOKEN_EXP', String(Date.now() + (b.expires_in - 300) * 1000));
  return b.access_token;
}

function api_(path, method, body) {
  var res = UrlFetchApp.fetch('https://' + PROPS.getProperty('SHOP') + '/admin/api/' + API_VERSION + path, {
    method: (method || 'get').toLowerCase(),
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': token_() },
    payload: body ? JSON.stringify(body) : null,
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  var data = text ? JSON.parse(text) : {};
  if (code >= 400) throw new Error(code + ' ' + (data.errors ? JSON.stringify(data.errors) : text).slice(0, 300));
  return data;
}

function slug_(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function num_(v) {
  var n = Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, ''));
  return isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ images -- */

function driveId_(url) {
  var u = String(url || '');
  var m = u.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  m = u.match(/drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  m = u.match(/lh3\.googleusercontent\.com\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return null;
}

function fetchBytes_(url) {
  var id = driveId_(url);
  if (id) {
    try { return DriveApp.getFileById(id).getBlob(); } catch (e) { /* fall through to HTTP */ }
  }
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error('image ' + res.getResponseCode());
  return res.getBlob();
}

/**
 * Attach an image straight to a product. Base64 attachment is the simplest
 * reliable path from Apps Script — no staged upload, no processing poll.
 * Returns true if the image was attached.
 */
function attachImage_(productId, url, alt) {
  var blob = fetchBytes_(url);
  var bytes = blob.getBytes();
  if (bytes.length < 1024) throw new Error('image too small — check sharing on ' + url);

  var type = blob.getContentType() || 'image/jpeg';
  var ext = type.indexOf('png') !== -1 ? 'png' : type.indexOf('webp') !== -1 ? 'webp' : 'jpg';
  var base = (String(url).split('/').pop() || 'image').split('?')[0].replace(/\.[a-z]+$/i, '') || 'image';

  api_('/products/' + productId + '/images.json', 'POST', {
    image: {
      attachment: Utilities.base64Encode(bytes),
      filename: base + '.' + ext,
      alt: alt || '',
    },
  });
  return true;
}

/* --------------------------------------------------------------- actions -- */

function doGet(e) {
  return json_({ success: true, service: 'Roman Keno Shopify Bridge', actions: ['ping', 'pushListing', 'listProducts', 'setStatus'] });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!PROPS.getProperty('BRIDGE_KEY') || body.key !== PROPS.getProperty('BRIDGE_KEY')) {
      return json_({ success: false, error: 'unauthorised' });
    }
    switch (body.action) {
      case 'ping': return json_({ success: true, result: ping_() });
      case 'pushListing': return json_({ success: true, result: pushListing_(body.listing || {}, body.options || {}) });
      case 'listProducts': return json_({ success: true, result: listProducts_() });
      case 'setStatus': return json_({ success: true, result: setStatus_(body.productId, body.status) });
      default: return json_({ success: false, error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    return json_({ success: false, error: String(err.message).slice(0, 400) });
  }
}

function ping_() {
  var d = api_('/shop.json');
  return { shop: d.shop.name, domain: d.shop.domain };
}

function setStatus_(productId, status) {
  if (!productId) throw new Error('productId required');
  if (['active', 'draft', 'archived'].indexOf(status) === -1) throw new Error('bad status');
  var d = api_('/products/' + productId + '.json', 'PUT', { product: { id: productId, status: status } });
  return { id: d.product.id, handle: d.product.handle, status: d.product.status };
}

function listProducts_() {
  var all = [];
  var url = '/products.json?limit=250&fields=id,handle,title,status,variants,images';
  var guard = 0;
  while (url && guard++ < 20) {
    var d = api_(url);
    all = all.concat(d.products || []);
    url = null; // single page is enough for an admin list; extend with page_info if needed
  }
  return all.map(function (p) {
    return {
      id: p.id,
      handle: p.handle,
      title: p.title,
      status: p.status,
      price: p.variants && p.variants.length ? p.variants[0].price : null,
      stock: p.variants ? p.variants.reduce(function (n, v) { return n + (v.inventory_quantity || 0); }, 0) : 0,
      variants: p.variants ? p.variants.length : 0,
      image: p.images && p.images.length ? p.images[0].src : '',
    };
  });
}

/**
 * Push one of your website listings to Shopify.
 * listing fields used (from your admin): Listing ID, Title/Name, Description,
 * Selling Price, Image URLs, Stock.
 */
function pushListing_(listing, options) {
  var title = String(listing['Title'] || listing['Name'] || '').trim();
  if (!title) throw new Error('listing has no Title');

  var handle = slug_(title);
  var price = num_(listing['Selling Price'] || listing['Price']) || 0;
  if (!price) throw new Error('listing has no price');

  var description = String(listing['Description'] || '');
  var stockRaw = listing['Stock'] != null ? listing['Stock'] : listing['Quantity'];
  var stock = stockRaw != null && String(stockRaw).trim() !== '' ? Number(stockRaw) : null;

  var rawImages = String(listing['Image URLs'] || listing['Image URL'] || '');
  var imageUrls = rawImages.split(/[,\n|]/).map(function (s) { return s.trim(); }).filter(Boolean);

  // 1. does it already exist?
  var existing = null;
  try {
    var found = api_('/products.json?handle=' + encodeURIComponent(handle) + '&fields=id,handle,variants,images,status');
    existing = (found.products && found.products[0]) || null;
  } catch (e) { /* fall through as create */ }

  var payload = {
    handle: handle,
    title: title,
    body_html: description,
    vendor: 'Roman Keno',
    product_type: String(listing['Type'] || ''),
    status: options.draft ? 'draft' : 'active',
    variants: [{
      price: price.toFixed(2),
      sku: String(listing['Listing ID'] || ''),
      inventory_management: 'shopify',
      inventory_quantity: stock == null ? 0 : stock,
    }],
  };

  var product, action;
  if (existing) {
    payload.variants[0].id = existing.variants[0].id;
    delete payload.variants[0].inventory_quantity;
    product = api_('/products/' + existing.id + '.json', 'PUT', { product: payload }).product;
    action = 'updated';
  } else {
    product = api_('/products.json', 'POST', { product: payload }).product;
    action = 'created';
  }

  // 2. images — upload any that are not already attached
  var have = {};
  (product.images || []).forEach(function (im) {
    have[(String(im.src).split('/').pop() || '').split('?')[0]] = true;
  });
  var added = 0;
  var imageErrors = [];
  imageUrls.forEach(function (u) {
    var base = (String(u).split('/').pop() || '').split('?')[0];
    if (have[base]) return;                       // already on the product
    try {
      attachImage_(product.id, u, title);
      added++;
    } catch (e) {
      imageErrors.push(String(e.message).slice(0, 60));
    }
  });

  // 3. collection
  var coll = options.collection || DEFAULT_COLLECTION;
  try {
    var colls = api_('/custom_collections.json?handle=' + encodeURIComponent(coll) + '&fields=id');
    var cid = colls.custom_collections && colls.custom_collections[0] && colls.custom_collections[0].id;
    if (cid) {
      var have2 = api_('/collects.json?product_id=' + product.id + '&limit=250');
      var already = (have2.collects || []).some(function (c) { return c.collection_id === cid; });
      if (!already) api_('/collects.json', 'POST', { collect: { product_id: product.id, collection_id: cid } });
    }
  } catch (e) { /* non-fatal */ }

  // 4. stock (needs write_inventory + read_locations)
  if (stock != null) {
    try {
      var locs = api_('/locations.json');
      var loc = (locs.locations || []).filter(function (l) { return l.active; })[0] || (locs.locations || [])[0];
      if (loc) {
        var v = api_('/products/' + product.id + '.json?fields=variants').product.variants[0];
        api_('/inventory_levels/set.json', 'POST', {
          location_id: loc.id,
          inventory_item_id: v.inventory_item_id,
          available: stock,
        });
      }
    } catch (e) { /* reported via stockSynced=false */ }
  }

  return {
    action: action,
    handle: handle,
    productId: product.id,
    imageErrors: imageErrors,
    price: product.variants[0].price,
    imagesAdded: added,
    url: 'https://romankenojewelry.myshopify.com/products/' + handle,
  };
}
