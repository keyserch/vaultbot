export default async function handler(req, res) {
  try {
    // --- Params via query string (fallback sur des valeurs par défaut) ---
    const url = new URL(req.url, `http://${req.headers.host}`);
    const owner = url.searchParams.get("owner") || "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo";
    const mint  = url.searchParams.get("mint")  || "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
    const circulatingSupply = Number(url.searchParams.get("supply")) || 10_000_000;
    const debug = url.searchParams.get("debug") === "1";

    // --- 1) Solana RPC (Ankr public) ---
    const rpcResp = await fetch("https://rpc.ankr.com/solana", {
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
      return res.status(502).json({ error: "RPC HTTP error", status: rpcResp.status, detail: text });
    }

    const rpcJson = await rpcResp.json();
    const accounts = rpcJson?.result?.value ?? [];

    // Somme des montants
    let totalRaw = 0n;
    let decimals = null;
    const sampleAccounts = [];

    for (const acc of accounts) {
      const ta = acc?.account?.data?.parsed?.info?.tokenAmount;
      if (ta?.amount && ta?.decimals != null) {
        totalRaw += BigInt(ta.amount);
        decimals = decimals ?? ta.decimals;
        if (sampleAccounts.length < 5) {
          sampleAccounts.push({
            pubkey: acc?.pubkey || null,
            amountRaw: ta.amount,
            decimals: ta.decimals
          });
        }
      }
    }

    const base = 10n ** BigInt(decimals || 0);
    const jitoSOL_amount = Number(totalRaw) / Number(base);

    // --- 2) Prix via Dexscreener (USD) ---
    let priceUsd = null;
    let dexInfo = null;
    try {
      const dexResp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/solana:${encodeURIComponent(mint)}`);
      if (dexResp.ok) {
        const dexJson = await dexResp.json();
        const pairs = dexJson?.pairs ?? [];
        dexInfo = { pairCount: pairs.length };
        if (pairs.length) {
          const best = pairs.reduce((a, b) =>
            (Number(b.liquidity?.usd || 0) > Number(a.liquidity?.usd || 0)) ? b : a
          );
          const cand = Number(best?.priceUsd);
          if (!Number.isNaN(cand) && cand > 0) {
            priceUsd = cand;
            dexInfo.best = {
              dexId: best?.dexId || null,
              pairAddress: best?.pairAddress || null,
              liquidityUsd: Number(best?.liquidity?.usd || 0) || null
            };
          }
        }
      } else {
        dexInfo = { httpStatus: dexResp.status };
      }
    } catch (e) {
      dexInfo = { error: String(e) };
    }

    const reserve_usd = (priceUsd != null) ? jitoSOL_amount * priceUsd : null;
    const price_floor_usd = (reserve_usd != null && circulatingSupply > 0)
      ? reserve_usd / circulatingSupply
      : null;

    const payload = {
      ok: true,
      owner,
      mint,
      accountsCount: accounts.length,
      decimals,
      jitoSOL_amount,
      reserve_usd,
      price_floor_usd
    };

    if (debug) {
      payload.debug = {
        sampleAccounts,
        dexInfo
      };
    }

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(payload);

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
