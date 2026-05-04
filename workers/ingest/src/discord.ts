import type { DetectedSignal } from './signals';

const SETUP_LABEL: Record<DetectedSignal['setup'], string> = {
  big_move_up: 'Big move up',
  big_move_down: 'Big move down',
  day_high_break: 'Day high break',
  day_low_break: 'Day low break',
};

const COLOR_GREEN = 0x16a34a;
const COLOR_RED = 0xdc2626;

export async function postDiscordSignal(webhookUrl: string, sig: DetectedSignal): Promise<void> {
  const isLong = sig.direction === 'long';
  const arrow = isLong ? 'UP' : 'DOWN';
  const embed = {
    title: `${sig.symbol} — ${SETUP_LABEL[sig.setup]} (${arrow})`,
    description: sig.notes,
    color: isLong ? COLOR_GREEN : COLOR_RED,
    fields: [
      { name: 'Price', value: sig.price.toFixed(2), inline: true },
      { name: 'Prev close', value: sig.prevClose.toFixed(2), inline: true },
      { name: 'Change', value: `${(sig.changePct * 100).toFixed(2)}%`, inline: true },
    ],
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
