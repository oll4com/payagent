const NETWORKS = { chipnet: 'bchtest', mainnet: 'bitcoincash' };

export function loadConfig(env = process.env) {
  const network = env.NETWORK ?? 'chipnet';
  if (!NETWORKS[network]) throw new Error(`NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}`);
  if (!env.HD_PUBLIC_KEY) throw new Error('set HD_PUBLIC_KEY: the watch-only xpub/tpub of the wallet that receives payments');
  const sats = (name, fallback) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  return {
    network,
    addressPrefix: NETWORKS[network],
    hdPublicKey: env.HD_PUBLIC_KEY,
    electrumHost: env.ELECTRUM_HOST ?? (network === 'chipnet' ? 'chipnet.imaginary.cash' : 'bch.imaginary.cash'),
    minPriceSats: sats('MIN_PRICE_SATS', 1000),
    autoMaxSats: sats('AUTO_MAX_SATS', 50_000),
    maxPriceSats: sats('MAX_PRICE_SATS', 1_000_000),
    autoMaxChars: sats('AUTO_MAX_CHARS', 1000),
    reviewToken: env.REVIEW_TOKEN ?? '',
    port: sats('PORT', 8787),
    dataDir: env.DATA_DIR ?? 'data'
  };
}
