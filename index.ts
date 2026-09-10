#!/usr/bin/env bun
import { parseArgs } from "node:util";

const UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

const LEAP = "https://shopapi.codashop.com";
const WHITELABEL_ID = 1;
const VOUCHER_TYPE = "CALL_OF_DUTY_MOBILE_WL";
const DAILY_REFRESH_RATE = 86400;

const RESULT_CODES: Record<number, string> = {
  0: "SUCCESS",
  1201: "ALREADY_CLAIMED",
  1202: "VALIDITY_EXPIRED",
  1203: "NOT_ELIGIBLE",
  1210: "PUBLISHER_SERVICE_ERROR",
  3009: "INVALID_REGION",
};

type HttpResult = [number, any];

async function httpJson(
  url: string,
  payload: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": UA,
    ...headers,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: h,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    try {
      return [res.status, JSON.parse(text)];
    } catch {
      return [res.status, {}];
    }
  } catch (e) {
    return [0, { _network_error: String(e) }];
  }
}

function leapHeaders(
  country: string,
  locale = "en-in",
): Record<string, string> {
  return {
    "Accept-Language": locale,
    "X-EXPT-TOKEN": "",
    "X-EXPT-CONTEXT": "",
    "X-WHITELABEL-ID": String(WHITELABEL_ID),
    "X-SESSION-COUNTRY2NAME": country.toUpperCase(),
  };
}

const FALLBACK_REGIONS = ["sa", "sg", "us", "eu", "me", "la", "af"];

interface Profile {
  username: string | null;
  shortId: string | null;
  picUrl: string | null;
  levelImage: string | null;
  rank: string | null;
  rankImage: string | null;
}

interface Meta {
  region: string;
  country: string;
}

async function validateOnce(
  playerId: string,
  country: string,
  region: string,
): Promise<HttpResult> {
  const url = `https://order-${region}.codashop.com/validate`;
  const payload = {
    country: country.toUpperCase(),
    voucherTypeName: VOUCHER_TYPE,
    whiteLabelId: String(WHITELABEL_ID),
    deviceId: crypto.randomUUID(),
    userId: playerId,
    zoneId: "",
  };
  return httpJson(url, payload, { "Accept-Language": "" });
}

async function validate(
  playerId: string,
  country: string,
  region: string,
  _seen?: Set<string>,
): Promise<[Profile | null, string | null, Meta | null]> {
  const seen = _seen ?? new Set<string>();
  const regions = region === "auto" ? FALLBACK_REGIONS : [region];
  let lastErr: string | null = null;

  for (const r of regions) {
    const key = `${r}|${country}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const [st, data] = await validateOnce(playerId, country, r);

    if (st !== 200 || data?._network_error) {
      lastErr = `validate via ${r}: HTTP ${st} ${JSON.stringify(data).slice(0, 200)}`;
      continue;
    }

    // Wrong country: API tells us the home country
    if (data.errorCode === -200) {
      const home = data.homeBaseCountry2Name;
      if (home) {
        const [res, err, meta] = await validate(playerId, home, region, seen);
        if (res) return [res, err, meta];
        lastErr = err;
        continue;
      }
      lastErr = `validate via ${r}: -200 but no homeBaseCountry2Name`;
      continue;
    }

    if (data.success === false) {
      return [
        null,
        `validate failed: ${data.errorMsg ?? data.errorCode}`,
        null,
      ];
    }

    const result = data.result ?? {};
    const profile: Profile = {
      username: result.username || result.nickname || null,
      shortId: result.shortId ?? null,
      picUrl: result.picUrl ?? null,
      levelImage: result.customLevelImageUrl ?? null,
      rank: result.customReadableMpRank ?? null,
      rankImage: result.customMpRankImageUrl ?? null,
    };
    return [profile, null, { region: r, country }];
  }

  return [null, lastErr ?? "validate: no region responded", null];
}

interface Product {
  productUrl: string;
  lvtId: any;
  gvtId: any;
  voucherTypeId: any;
  voucherTypeName: string;
  paymentChannelId: number;
}

async function productPage(
  country: string,
  productPath: string,
  locale: string,
): Promise<[Product | null, string | null]> {
  const errs: string[] = [];
  let data: any = null;

  for (const loc of [locale, `ar-${country.toLowerCase()}`, "en-in"]) {
    const [st, d] = await httpJson(
      LEAP + "/productPage",
      { productPath, locale: loc, whitelabelId: WHITELABEL_ID },
      leapHeaders(country, loc),
    );
    if (st === 200 && d?.productInfo) {
      data = d;
      break;
    }
    errs.push(`${loc}: HTTP ${st} ${JSON.stringify(d).slice(0, 200)}`);
  }

  if (!data) {
    return [
      null,
      `productPage ${productPath}: no product for country ${country} (${errs.join("; ")})`,
    ];
  }

  const pi = data.productInfo ?? {};
  let pc: number | null = null;
  const channels = data.paymentChannels ?? [];
  if (channels.length > 0) {
    pc = channels[0].id;
  }
  if (pc == null) {
    for (const sku of data.skus ?? []) {
      const prices = sku?.pricing?.paymentChannelPrices ?? {};
      const keys = Object.keys(prices);
      if (keys.length > 0) {
        pc = Number(keys[0]);
        break;
      }
    }
  }

  return [
    {
      productUrl: pi.productUrl ?? productPath,
      lvtId: pi.id,
      gvtId: pi.gvtId,
      voucherTypeId: pi.voucherTypeId,
      voucherTypeName: pi.voucherTypeName,
      paymentChannelId: pc ?? 391,
    },
    null,
  ];
}

interface Freebie {
  skuId: string;
  name: string;
  status: string;
  buyUrl: string;
  remaining: number | null;
  limit: number | null;
  refreshRate: number | null;
  refreshAtUnix: number | null;
}

async function dynamicSkuInfo(
  country: string,
  deviceId: string,
  userId: string,
  prod: Product,
  locale: string,
): Promise<[any, Freebie[] | null, string | null]> {
  const [st, data] = await httpJson(
    LEAP + "/productPage/dynamicSkuInfo",
    {
      deviceId,
      whitelabelId: WHITELABEL_ID,
      userId,
      serverId: "",
      characterId: "",
      worldId: "",
      locale,
      productPath: prod.productUrl,
    },
    leapHeaders(country, locale),
  );

  if (st !== 200) {
    return [
      null,
      null,
      `dynamicSkuInfo HTTP ${st}: ${JSON.stringify(data).slice(0, 300)}`,
    ];
  }

  const skus = data.skus ?? [];
  const freebies: Freebie[] = [];
  for (const s of skus) {
    const scheme = String(s?.pricing?.pricingScheme ?? "").toUpperCase();
    if (scheme !== "FREEBIE" || !String(s?.BuyUrl ?? "").includes("claim"))
      continue;
    const lim = s.PurchaseLimit ?? {};
    freebies.push({
      skuId: s.Id,
      name: s.SkuName,
      status: s.Status,
      buyUrl: s.BuyUrl,
      remaining: lim.limitRemaining ?? null,
      limit: lim.limit ?? null,
      refreshRate: lim.refreshRate ?? null,
      refreshAtUnix: lim.refreshAtUnix ?? null,
    });
  }
  return [data, freebies, null];
}

async function createOrderToken(
  country: string,
  prod: Product,
  sku: Freebie,
  pageLockToken: string,
  locale = "en-in",
): Promise<[string | null, string | null]> {
  const [st, data] = await httpJson(
    LEAP + "/productPage/createOrderToken",
    {
      pageLockToken,
      productPath: prod.productUrl,
      skuId: sku.skuId,
      paymentChannelId: prod.paymentChannelId,
      whitelabelId: WHITELABEL_ID,
    },
    leapHeaders(country, locale),
  );

  if (st !== 200) {
    return [
      null,
      `createOrderToken HTTP ${st}: ${JSON.stringify(data).slice(0, 300)}`,
    ];
  }
  const token = data.dynamicSkuToken;
  if (!token) {
    return [
      null,
      `createOrderToken: no dynamicSkuToken in ${JSON.stringify(data).slice(0, 200)}`,
    ];
  }
  return [token, null];
}

function buildClaimForm(
  prod: Product,
  sku: Freebie,
  userId: string,
  token: string,
  status: string,
  shopLang: string,
): Record<string, string> {
  return {
    shopLang,
    "user.userId": userId,
    "user.zoneId": "",
    checkoutId: crypto.randomUUID(),
    dynamicSkuToken: token,
    status,
    lvtId: String(prod.lvtId),
    skuId: sku.skuId,
    pricingScheme: "freebie",
    gvtId: String(prod.gvtId),
    voucherTypeId: String(prod.voucherTypeId),
    voucherTypeName: prod.voucherTypeName,
    callOrderAPI: "false",
  };
}

async function claim(
  sku: Freebie,
  form: Record<string, string>,
): Promise<HttpResult> {
  try {
    const body = new URLSearchParams(form).toString();
    const res = await fetch(sku.buyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Referer: "https://store.callofdutymobile.com/",
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    try {
      return [200, JSON.parse(raw)];
    } catch {
      return [200, { _raw: raw.slice(0, 500) }];
    }
  } catch (e) {
    return [0, { _network_error: String(e) }];
  }
}

function pickFreebie(freebies: Freebie[], claimAll: boolean): Freebie[] {
  const avail = freebies.filter((f) => f.status === "ACTIVE" && !!f.remaining);
  // Tuple sort: (refreshRate != DAILY, remaining == 0) — false < true
  avail.sort((a, b) => {
    const aNotDaily = a.refreshRate !== DAILY_REFRESH_RATE;
    const bNotDaily = b.refreshRate !== DAILY_REFRESH_RATE;
    if (aNotDaily !== bNotDaily) return aNotDaily ? 1 : -1;
    const aZero = a.remaining === 0;
    const bZero = b.remaining === 0;
    if (aZero !== bZero) return aZero ? 1 : -1;
    return 0;
  });
  return claimAll ? avail : avail.slice(0, 1);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      country: { type: "string", default: "IN" },
      region: { type: "string", default: "auto" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      status: { type: "string" },
      all: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (positionals.length < 1) {
    console.error(
      "Usage: bun index.ts <player_id> [--country IN] [--region auto] [--dry-run] [--json] [--status X] [--all]",
    );
    return 1;
  }
  const playerId = positionals[0]!;

  const asJson = Boolean(values.json);
  const countryGuess = String(values.country).toUpperCase();
  const regionArg = String(values.region);

  const out: any = {
    player_id: playerId,
    region: regionArg,
    country_guess: countryGuess,
  };
  let exitCode = 0;

  debugger;
  // --- Validate ---
  const [profile, err, meta] = await validate(
    playerId,
    countryGuess,
    regionArg,
  );
  if (err) {
    out.ok = false;
    out.step = "validate";
    out.error = err;
    console.log(asJson ? JSON.stringify(out, null, 2) : err);
    return 3;
  }
  out.profile = profile;
  out.resolved = meta;
  const claimUser = profile!.shortId || playerId;

  const resolvedCountry = meta?.country || countryGuess;
  out.country = resolvedCountry;
  const cc = resolvedCountry.toLowerCase();
  const productPath = `/${cc}/codm`;
  const locale = `en-${cc}`;
  const shopLang = `en_${cc}`;

  // --- Product page ---
  const [prod, prodErr] = await productPage(
    resolvedCountry,
    productPath,
    locale,
  );
  if (prodErr) {
    out.ok = false;
    out.step = "productPage";
    out.error = prodErr;
    console.log(asJson ? JSON.stringify(out, null, 2) : prodErr);
    return 3;
  }

  // --- Dynamic SKU info ---
  const deviceId = crypto.randomUUID();
  const skuUser = profile!.shortId || playerId.toUpperCase();
  const [data, freebies, skuErr] = await dynamicSkuInfo(
    resolvedCountry,
    deviceId,
    skuUser,
    prod!,
    locale,
  );
  if (skuErr) {
    out.ok = false;
    out.step = "dynamicSkuInfo";
    out.error = skuErr;
    console.log(asJson ? JSON.stringify(out, null, 2) : skuErr);
    return 3;
  }

  const targets = pickFreebie(freebies!, Boolean(values.all));
  out.freebies = freebies;
  if (targets.length === 0) {
    let msg = "no claimable freebie: ";
    if (!freebies || freebies.length === 0) {
      msg += "no FREEBIE skus returned by the store";
    } else {
      msg += freebies
        .map((f) => `${f.name} (${f.status}, remaining ${f.remaining})`)
        .join(", ");
    }
    out.ok = false;
    out.step = "select";
    out.error = msg;
    console.log(asJson ? JSON.stringify(out, null, 2) : msg);
    return 2;
  }

  // --- Claim loop ---
  const results: any[] = [];
  for (const sku of targets) {
    const [token, tokenErr] = await createOrderToken(
      resolvedCountry,
      prod!,
      sku,
      data?.pageLockToken || "",
      locale,
    );
    if (tokenErr) {
      results.push({
        skuId: sku.skuId,
        ok: false,
        step: "createOrderToken",
        error: tokenErr,
      });
      exitCode = exitCode || 3;
      continue;
    }

    const statusArg =
      (values.status as string | undefined) || (sku.status || "ACTIVE")[0]!;

    const form = buildClaimForm(
      prod!,
      sku,
      claimUser,
      token!,
      statusArg,
      shopLang,
    );

    if (values["dry-run"]) {
      results.push({
        skuId: sku.skuId,
        name: sku.name,
        ok: true,
        dry_run: true,
        claim_url: sku.buyUrl,
        form,
        next_refresh_unix: sku.refreshAtUnix,
      });
      continue;
    }

    const [, resp] = await claim(sku, form);
    const code = resp.RESULT_CODE;
    const codeName = RESULT_CODES[code] ?? `UNKNOWN(${code})`;

    const responseFiltered = Object.fromEntries(
      Object.entries(resp).filter(([k]) =>
        ["RESULT_CODE", "errorMsg", "errorCode", "message", "orderId"].includes(
          k,
        ),
      ),
    );

    results.push({
      skuId: sku.skuId,
      name: sku.name,
      ok: code === 0,
      result_code: code,
      result: codeName,
      response: responseFiltered,
    });

    if (code === 0) continue;
    if (code === 1201) {
      exitCode = exitCode || 0;
    } else {
      exitCode = 3;
    }
  }

  out.ok = results.every((r) => r.ok);
  out.claims = results;

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const r of results) {
      if (r.dry_run) {
        console.log(
          `[dry-run] would claim ${r.name} (${r.skuId}) -> ${r.claim_url}`,
        );
        console.log("          form:", JSON.stringify(r.form));
      } else {
        const respStr =
          r.response && Object.keys(r.response).length > 0
            ? ` (${JSON.stringify(r.response)})`
            : "";
        console.log(`${r.name}: ${r.result}${respStr}`);
      }
    }
    if (profile) {
      const name = profile.username ?? "?";
      const id = profile.shortId ? ` [${profile.shortId}]` : "";
      console.log(`player: ${name}${id}`);
    }
    if (results.length > 0 && results[0].next_refresh_unix) {
      console.log(
        "next daily refresh (UTC):",
        new Date(results[0].next_refresh_unix * 1000).toISOString(),
      );
    }
  }

  return exitCode;
}

process.exit(await main());
