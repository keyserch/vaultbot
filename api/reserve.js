// api/reserve.js — version Vercel alignée sur ta logique Wix
// Lit owner, mint, supply depuis la query string si fournis.
// Utilise Helius (SOLANA_RPC_URL) pour le RPC.
// Prix JitoSOL: d'abord tokens endpoint par mint, sinon fallback search jitosol/sol (jitoInSol * solPriceUsd).
// APY Jito: identique à ton fetchJitoApy() (renvoie décimal pour l'API du bot).

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const owner = url.searchParams.get("owner") || "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo";
    const mint  = url.searchParams.get("mint")  || "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"; // JitoSOL
    const supply = Number(url.searchParams.get("supply")) || 10_000_000; // à remplacer quand tu as la vraie supply
    const debug  = url.searchParams.get("debug") === "1";

    // ---- 1) Réserve JitoSOL via RPC ----
    const RPC = process.env.SOLANA_RPC_URL || "https://solana-api.projectserum.com";
    const rpcResp = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [ owner, { mint }, { encoding: "jsonParsed" } ]
      })
    });
    if (!rpcResp.ok) {
      const text = await rpcResp.text();
      return res.status(502).json({ ok:false, error:"RPC HTTP error", status:rpcResp.status, detail:text });
    }
    const rpcJson = await rpcResp.json();
    if (rpcJson.error) return res.status(502).json({ ok:false, error:"RPC JSON error", detail:rpcJson.error });

    const accounts = rpcJson?.result?.value ?? [];
    let totalRaw = 0n, decimals = null;
    const sampleAccounts = [];
    for (const acc of accounts) {
      const ta = acc?.account?.data?.parsed?.info?.tokenAmount;
      if (ta?.amount && ta?.decimals != null) {
        totalRaw += BigInt(ta.amount);
        if (decimals == null) decimals = ta.decimals;
        if (sampleAccounts.length < 5) sampleAccounts.push({ pubkey: acc?.pubkey, amountRaw: ta.amount, decimals: ta.decimals });
      }
    }
    const base = 10n ** BigInt(decimals || 0);
    const reserveJito = Number(totalRaw) / Number(base); // == resp.totalUiNumber

    // ---- 2) Prix JitoSOL USD (Dexscreener) ----
    let priceUsd = null;
    let dexInfo = {};

    // 2.a Tokens endpoint (mint direct)
    try {
      const r1 = await fetch(`https://api.dexscreener.com/latest/dex/tokens/solana:${encodeURIComponent(mint)}`);
      if (r1.ok) {
        const j = await r1.json();
        const pairs = j?.pairs ?? [];
        dexInfo.tokensPairCount = pairs.length;
        if (pairs.length) {
          const best = pairs.reduce((a,b)=> (Number(b.liquidity?.usd||0) > Number(a.liquidity?.usd||0)) ? b : a);
          const cand = Number(best?.priceUsd);
          if (!Number.isNaN(cand) && cand > 0) priceUsd = cand;
        }
      } else dexInfo.tokensHttp = r1.status;
    } catch (e) { dexInfo.tokensErr = String(e); }

    // 2.b Fallback: search "jitosol sol" → jitoInSol * (priceUsd/priceNative)
    if (priceUsd == null) {
      try {
        const r2 = await fetch("https://api.dexscreener.com/latest/dex/search?q=jitosol%20sol");
        if (r2.ok) {
          const s = await r2.json();
          const pairs = Array.isArray(s.pairs) ? s.pairs : [];
          const candidates = pairs.filter(p =>
            p.chainId === "solana" &&
            (p.quoteToken?.symbol?.toUpperCase() === "SOL") &&
            (p.baseToken?.symbol?.toUpperCase().includes("JITO"))
          );
          if (candidates.length) {
            candidates.sort((a,b)=> (Number(b.liquidity?.usd||0)||0) - (Number(a.liquidity?.usd||0)||0));
            const best = candidates[0];
            const jitoInSol   = Number(best?.priceNative);     // JitoSOL in SOL
            const solPriceUsd = Number(best?.priceUsd) / jitoInSol; // SOL in $
            if (Number.isFinite(jitoInSol) && Number.isFinite(solPriceUsd) && jitoInSol>0 && solPriceUsd>0) {
              priceUsd = jitoInSol * solPriceUsd;              // JitoSOL in $
              dexInfo.searchUsed = { pairAddress: best?.pairAddress || null, liqUsd: Number(best?.liquidity?.usd||0)||null };
            }
          } else dexInfo.searchPairCount = 0;
        } else dexInfo.searchHttp = r2.status;
      } catch (e) { dexInfo.searchErr = String(e); }
    }

    // ---- 3) APY Jito (comme ton fetchJitoApy, renvoyé en décimal) ----
    let jito_apy = null;
    try {
      const r = await fetch("https://kobe.mainnet.jito.network/api/v1/stake_pool_stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket_type: "Daily",
          range_filter: { start: "2022-10-31T00:00:00Z", end: new Date().toISOString() },
          sort_by: { field: "BlockTime", order: "Asc" }
        })
      });
      if (r.ok) {
        const d = await r.json();
        const apySeries = d?.apy || [];
        const last = apySeries[apySeries.length - 1];
        if (last && typeof last.data === "number") jito_apy = last.data; // 6.9% => 0.069
      }
    } catch (_) {}

    // ---- 4) Valeur & floor ----
    const reserve_usd = (priceUsd != null) ? reserveJito * priceUsd : null;
    const price_floor_usd = (reserve_usd != null && supply > 0) ? (reserve_usd / supply) : null;

    const payload = {
      ok: true,
      owner, mint,
      accountsCount: accounts.length,
      decimals,
      jitoSOL_amount: reserveJito,
      reserve_usd,
      jito_apy,              // décimal (0.0662 pour 6.62%)
      price_floor_usd
    };
    if (debug) payload.debug = { sampleAccounts, dexInfo, rpcUsed: RPC };

    res.setHeader("Content-Type","application/json");
    return res.status(200).json(payload);

  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
}

