export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const owner = url.searchParams.get("owner") || "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo";
    const mint  = url.searchParams.get("mint")  || "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
    const supply = Number(url.searchParams.get("supply")) || 10_000_000;
    const debug  = url.searchParams.get("debug") === "1";

    // ---- RPC avec clé (recommandé) ----
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
      return res.status(502).json({ error: "RPC HTTP error", status: rpcResp.status, detail: text });
    }

    const rpcJson = await rpcResp.json();
    if (rpcJson.error) {
      return res.status(502).json({ error: "RPC JSON error", detail: rpcJson.error });
    }

    const accounts = rpcJson?.result?.value ?? [];
    let totalRaw = 0n, decimals = null;
    const sample = [];
    for (const acc of accounts) {
      const ta = acc?.account?.data?.parsed?.info?.tokenAmount;
      if (ta?.amount && ta?.decimals != null) {
        totalRaw += BigInt(ta.amount);
        if (decimals == null) decimals = ta.decimals;
        if (sample.length < 5) sample.push({ pubkey: acc?.pubkey, amountRaw: ta.amount, decimals: ta.decimals });
      }
    }
    const base = 10n ** BigInt(decimals || 0);
    const jitoSOL_amount = Number(totalRaw) / Number(base);

    // Prix USD via Dexscreener
    let priceUsd = null, dexInfo = null;
    const dex = await fetch(`https://api.dexscreener.com/latest/dex/tokens/solana:${encodeURIComponent(mint)}`);
    if (dex.ok) {
      const j = await dex.json();
      const pairs = j?.pairs ?? [];
      dexInfo = { pairCount: pairs.length };
      if (pairs.length) {
        const best = pairs.reduce((a,b)=> (Number(b.liquidity?.usd||0) > Number(a.liquidity?.usd||0)) ? b : a);
        const cand = Number(best?.priceUsd);
        if (!Number.isNaN(cand) && cand > 0) {
          priceUsd = cand;
          dexInfo.best = { pairAddress: best?.pairAddress || null, liquidityUsd: Number(best?.liquidity?.usd||0)||null };
        }
      }
    } else {
      dexInfo = { httpStatus: dex.status };
    }

    const reserve_usd = priceUsd != null ? jitoSOL_amount * priceUsd : null;
    const price_floor_usd = (reserve_usd != null && supply > 0) ? reserve_usd / supply : null;

    const payload = {
      ok: true, owner, mint,
      accountsCount: accounts.length,
      decimals,
      jitoSOL_amount,
      reserve_usd,
      price_floor_usd
    };
    if (debug) payload.debug = { sampleAccounts: sample, dexInfo, rpcUsed: RPC };

    res.setHeader("Content-Type","application/json");
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
}
