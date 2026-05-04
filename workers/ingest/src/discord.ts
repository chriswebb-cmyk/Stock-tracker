import type { DetectedSignal } from '../../../shared/setups';

export type DiscordSignal = DetectedSignal & { mlProbability?: number | null };

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

export async function postDiscordSignal(webhookUrl: string, sig: DiscordSignal): Promise<void> {
  const isLong = sig.direction === 'long';
  const arrow = isLong ? 'UP' : 'DOWN';
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'Price', value: sig.price.toFixed(2), inline: true },
    { name: 'Prev close', value: sig.prevClose.toFixed(2), inline: true },
    { name: 'Day change', value: `${(sig.changePct * 100).toFixed(2)}%`, inline: true },
  ];
  const rsi = sig.features.rsi;
  const vwap = sig.features.vwap;
  const atr = sig.features.atr;
  if (typeof rsi === 'number' && Number.isFinite(rsi)) {
    fields.push({ name: 'RSI', value: rsi.toFixed(1), inline: true });
  }
  if (typeof vwap === 'number' && Number.isFinite(vwap)) {
    fields.push({ name: 'VWAP', value: vwap.toFixed(2), inline: true });
  }
  if (typeof atr === 'number' && Number.isFinite(atr)) {
    fields.push({ name: 'ATR', value: atr.toFixed(2), inline: true });
  }
  if (typeof sig.mlProbability === 'number' && Number.isFinite(sig.mlProbability)) {
    fields.push({
      name: 'ML score',
      value: `${(sig.mlProbability * 100).toFixed(1)}%`,
      inline: true,
    });
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
