export default async function handler(req, res) {
  try {
    const owner="9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo"
    const mint="J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"
    const supply=10_000_000

    // Solana RPC (Ankr gratuit)
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

    const rpcJson = await rpcResp.json();
    const accounts = rpcJson.result?.value ?? [];

    let totalRaw = 0n;
    let decimals = null;
    for (const acc of accounts) {
      const ta = acc?.account?.data?.parsed?.info?.tokenAmount;
      if (ta?.amount && ta?.decimals != null) {
        totalRaw += BigInt(ta.amount);
        decimals = ta.decimals;
      }
    }
    const base = 10n ** BigInt(decimals || 0);
    const jitoSOL_amount = Number(totalRaw) / Number(base);

    // Dexscreener pour prix USD
    let priceUsd = null;
    const dexResp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/solana:${mint}`);
    if (dexResp.ok) {
      const dexJson = await dexResp.json();
      const pairs = dexJson?.pairs ?? [];
      if (pairs.length) {
        let best = pairs.reduce((a, b) =>
          (Number(b.liquidity?.usd || 0) > Number(a.liquidity?.usd || 0)) ? b : a
        );
        const cand = Number(best?.priceUsd);
        if (!isNaN(cand) && cand > 0) priceUsd = cand;
      }
    }

    const reserve_usd = priceUsd ? jitoSOL_amount * priceUsd : null;
    const price_floor_usd = (reserve_usd && supply > 0) ? reserve_usd / supply : null;

    res.setHeader("Content-Type","application/json");
    res.status(200).json({ jitoSOL_amount, reserve_usd, price_floor_usd });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
