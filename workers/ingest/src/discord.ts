import type { DetectedSignal } from './setups';

const SETUP_LABEL: Record<DetectedSignal['setup'], string> = {
  vwap_reclaim_long: 'VWAP reclaim',
  vwap_reject_short: 'VWAP rejection',
  orb_breakout_long: 'Opening range breakout',
  orb_breakdown_short: 'Opening range breakdown',
  bb_squeeze_release_long: 'Bollinger squeeze (up)',
  bb_squeeze_release_short: 'Bollinger squeeze (down)',
  rsi_oversold_reversal: 'RSI oversold reversal',
  rsi_overbought_reversal: 'RSI overbought reversal',
};

const COLOR_GREEN = 0x16a34a;
const COLOR_RED = 0xdc2626;

export async function postDiscordSignal(webhookUrl: string, sig: DetectedSignal): Promise<void> {
  const isLong = sig.direction === 'long';
  const arrow = isLong ? 'UP' : 'DOWN';
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'Price', value: sig.price.toFixed(2), inline: true },
    { name: 'Prev close', value: sig.prevClose.toFixed(2), inline: true },
    { name: 'Day change', value: `${(sig.changePct * 100).toFixed(2)}%`, inline: true },
  ];
  if (Number.isFinite(sig.features.rsi)) {
    fields.push({ name: 'RSI', value: sig.features.rsi.toFixed(1), inline: true });
  }
  if (Number.isFinite(sig.features.vwap)) {
    fields.push({ name: 'VWAP', value: sig.features.vwap.toFixed(2), inline: true });
  }
  if (Number.isFinite(sig.features.atr)) {
    fields.push({ name: 'ATR', value: sig.features.atr.toFixed(2), inline: true });
  }

  const embed = {
    title: `${sig.symbol} — ${SETUP_LABEL[sig.setup]} (${arrow})`,
    description: sig.notes,
    color: isLong ? COLOR_GREEN : COLOR_RED,
    fields,
    timestamp: new Date(sig.ts * 1000).toISOString(),
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord webhook failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
