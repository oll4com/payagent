const NETWORKS = { chipnet: 'bchtest', mainnet: 'bitcoincash' };

export function loadConfig(env = process.env) {
  const network = env.NETWORK ?? 'chipnet';
  if (!NETWORKS[network]) throw new Error(`NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}`);
  const sats = (name, fallback) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  return {
    network,
    addressPrefix: NETWORKS[network],
    // Defaults for the receiving wallet; the owner page can pair a wallet instead (DATA_DIR/owner.json wins).
    hdPublicKey: env.HD_PUBLIC_KEY ?? '',
    hdPublicKeyPath: env.HD_PUBLIC_KEY_PATH ?? 'account',
    receiveAddress: env.RECEIVE_ADDRESS ?? '',
    paymentWindowHours: sats('PAYMENT_WINDOW_HOURS', 24),
    // Abuse limits for a public demo whose payments are free test coins: new tasks per client per hour and per day overall.
    tasksPerIpHour: sats('TASKS_PER_IP_HOUR', 5),
    trustProxy: env.TRUST_PROXY === '1',
    tasksPerDay: sats('TASKS_PER_DAY', 200),
    agentMaxTokens: sats('AGENT_MAX_TOKENS', 800),
    electrumHost: env.ELECTRUM_HOST ?? (network === 'chipnet' ? 'chipnet.imaginary.cash' : 'bch.imaginary.cash'),
    minPriceSats: sats('MIN_PRICE_SATS', 1000),
    autoMaxSats: sats('AUTO_MAX_SATS', 50_000),
    maxPriceSats: sats('MAX_PRICE_SATS', 1_000_000),
    autoMaxChars: sats('AUTO_MAX_CHARS', 1000),
    reviewToken: env.REVIEW_TOKEN ?? '',
    repoUrl: env.REPO_URL ?? '',
    donationAddress: env.DONATION_ADDRESS ?? '',
    port: sats('PORT', 8787),
    dataDir: env.DATA_DIR ?? 'data'
  };
}
