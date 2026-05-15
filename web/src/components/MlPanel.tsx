import { useEffect, useState } from 'react';
import { api, type MetaModelRow, type ModelRow, type ModelsResponse, type SignalRow } from '../api';

const SETUP_LABEL: Record<string, string> = {
  vwap_reclaim_long: 'VWAP reclaim',
  vwap_reject_short: 'VWAP rejection',
  orb_breakout_long: 'ORB breakout',
  orb_breakdown_short: 'ORB breakdown',
  bb_squeeze_release_long: 'BB squeeze (up)',
  bb_squeeze_release_short: 'BB squeeze (down)',
  rsi_oversold_reversal: 'RSI oversold rev.',
  rsi_overbought_reversal: 'RSI overbought rev.',
};

// Hardcoded to match TARGET_HOLD_MINUTES in workers/ingest/wrangler.toml.
// If you change it there, change it here too — they should agree so the
// 'used live' badge marks the right horizon.
const ACTIVE_HOLD = 120;

function fmtAge(ts: number): string {
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function fmtEdge(edge: number): string {
  return (edge >= 0 ? '+' : '') + (edge * 100).toFixed(1) + '%';
}

export function MlPanel() {
  const [modelsResp, setModelsResp] = useState<ModelsResponse | null>(null);
  const [signals, setSignals] = useState<SignalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retraining, setRetraining] = useState(false);
  const [retrainStatus, setRetrainStatus] = useState<string | null>(null);

  const reload = () => {
    setError(null);
    Promise.all([api.models(), api.signals(50)])
      .then(([m, s]) => {
        setModelsResp(m);
        setSignals(s);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    reload();
    const id = window.setInterval(reload, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const retrain = async () => {
    setRetraining(true);
    setRetrainStatus('training…');
    try {
      const result = await api.trainModels(7, 30);
      setRetrainStatus(`Trained ${result.perSetup.length} setups on ${result.trades} trades.`);
      reload();
    } catch (e) {
      setRetrainStatus('Failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRetraining(false);
    }
  };

  // Group per-setup model rows by hold_minutes.
  const perSetupByHold = new Map<number, ModelRow[]>();
  if (modelsResp) {
    for (const m of modelsResp.perSetup) {
      const list = perSetupByHold.get(m.hold_minutes) ?? [];
      list.push(m);
      perSetupByHold.set(m.hold_minutes, list);
    }
  }
  const holds = Array.from(perSetupByHold.keys()).sort((a, b) => a - b);
  const metaByHold = new Map<number, MetaModelRow>();
  if (modelsResp) {
    for (const m of modelsResp.meta) metaByHold.set(m.hold_minutes, m);
  }

  return (
    <div className="p-4 space-y-6">
      <section className="bg-slate-900/50 border border-slate-800 rounded p-3 text-sm text-slate-300 space-y-2">
        <div className="text-xs uppercase tracking-wider text-slate-400">How to read this page</div>
        <p>
          The system trains one ML model per <span className="text-slate-200">setup</span> (a
          pattern detector like &quot;VWAP reclaim&quot; or &quot;BB squeeze release&quot;) at
          each <span className="text-slate-200">hold period</span> (15m, 30m, 60m, 120m). A
          higher-level <span className="text-slate-200">meta-ensemble</span> stacks all
          setups together to produce a unified probability per horizon.
        </p>
        <ul className="list-disc pl-5 space-y-1 text-xs text-slate-400">
          <li><span className="text-slate-200">Samples</span> — historical trades the model trained on. Below 100 is noisy.</li>
          <li><span className="text-slate-200">Train acc</span> — how well the model fits the training data.</li>
          <li><span className="text-slate-200">Val acc</span> — how well it predicts on held-out data it didn&apos;t train on. This is the honest measure.</li>
          <li><span className="text-slate-200">Baseline</span> — accuracy of just guessing the majority class. Beating this is the bar.</li>
          <li><span className="text-emerald-400">Edge = Val − Baseline.</span> Positive = the model is learning real patterns. Negative = worse than guessing.</li>
        </ul>
        <p className="text-xs text-slate-400">
          The live worker consults the <span className="text-emerald-400">{ACTIVE_HOLD}m</span> meta model
          to gate Discord alerts. A signal must pass that model&apos;s probability threshold
          to fire.
        </p>
      </section>

      <section>
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-sm uppercase tracking-wider text-slate-400">Meta-ensemble by horizon</h2>
          <button
            type="button"
            onClick={retrain}
            disabled={retraining}
            className="ml-auto px-2 py-1 text-xs rounded bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50"
          >
            {retraining ? 'Retraining…' : 'Retrain now'}
          </button>
          {retrainStatus && <span className="text-xs text-slate-400">{retrainStatus}</span>}
        </div>
        {error && <div className="text-rose-400 text-xs">{error}</div>}
        {modelsResp && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="text-left py-1 pr-3">Hold</th>
                  <th className="text-right py-1 px-2">Samples</th>
                  <th className="text-right py-1 px-2">Train</th>
                  <th className="text-right py-1 px-2">Val</th>
                  <th className="text-right py-1 px-2">Baseline</th>
                  <th className="text-right py-1 px-2">Edge</th>
                  <th className="text-right py-1 pl-2">Trained</th>
                </tr>
              </thead>
              <tbody>
                {modelsResp.meta.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-3 text-slate-500 italic">
                      No meta models yet. Click Retrain.
                    </td>
                  </tr>
                )}
                {modelsResp.meta.map((m) => {
                  const edge = m.val_accuracy - m.train_baseline;
                  const active = m.hold_minutes === ACTIVE_HOLD;
                  return (
                    <tr key={m.hold_minutes} className={'border-t border-slate-800 ' + (active ? 'bg-slate-900' : '')}>
                      <td className="py-1 pr-3 font-medium">
                        {m.hold_minutes}m
                        {active && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-emerald-900 text-emerald-300">live</span>}
                      </td>
                      <td className="text-right px-2 tabular-nums">{m.sample_count}</td>
                      <td className="text-right px-2 tabular-nums">{fmtPct(m.train_accuracy)}</td>
                      <td className="text-right px-2 tabular-nums">{fmtPct(m.val_accuracy)}</td>
                      <td className="text-right px-2 tabular-nums text-slate-500">{fmtPct(m.train_baseline)}</td>
                      <td className={'text-right px-2 tabular-nums ' + (edge > 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {fmtEdge(edge)}
                      </td>
                      <td className="text-right pl-2 text-slate-400 text-xs">{fmtAge(m.trained_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {holds.map((hold) => {
        const rows = perSetupByHold.get(hold) ?? [];
        const meta = metaByHold.get(hold);
        return (
          <section key={hold}>
            <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">
              Per-setup · {hold}m hold
              {hold === ACTIVE_HOLD && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-emerald-900 text-emerald-300 normal-case">live</span>}
              {meta && (
                <span className="ml-3 text-xs normal-case tracking-normal text-slate-500">
                  meta val {fmtPct(meta.val_accuracy)} · baseline {fmtPct(meta.train_baseline)} ·{' '}
                  <span className={meta.val_accuracy - meta.train_baseline > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {fmtEdge(meta.val_accuracy - meta.train_baseline)}
                  </span>
                </span>
              )}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-slate-500">
                  <tr>
                    <th className="text-left py-1 pr-3">Setup</th>
                    <th className="text-right py-1 px-2">Samples</th>
                    <th className="text-right py-1 px-2">Train</th>
                    <th className="text-right py-1 px-2">Val</th>
                    <th className="text-right py-1 px-2">Baseline</th>
                    <th className="text-right py-1 px-2">Edge</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => {
                    const edge = m.val_accuracy - m.train_baseline;
                    return (
                      <tr key={m.setup} className="border-t border-slate-800">
                        <td className="py-1 pr-3">{SETUP_LABEL[m.setup] ?? m.setup}</td>
                        <td className="text-right px-2 tabular-nums">{m.sample_count}</td>
                        <td className="text-right px-2 tabular-nums">{fmtPct(m.train_accuracy)}</td>
                        <td className="text-right px-2 tabular-nums">{fmtPct(m.val_accuracy)}</td>
                        <td className="text-right px-2 tabular-nums text-slate-500">{fmtPct(m.train_baseline)}</td>
                        <td className={'text-right px-2 tabular-nums ' + (edge > 0 ? 'text-emerald-400' : 'text-rose-400')}>
                          {fmtEdge(edge)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">Recent signals</h2>
        {signals && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="text-left py-1 pr-3">When</th>
                  <th className="text-left py-1 px-2">Symbol</th>
                  <th className="text-left py-1 px-2">Setup</th>
                  <th className="text-left py-1 px-2">Dir</th>
                  <th className="text-right py-1 px-2">ML</th>
                  <th className="text-left py-1 pl-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {signals.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-3 text-slate-500 italic">
                      No signals stored yet.
                    </td>
                  </tr>
                )}
                {signals.map((s) => (
                  <tr key={s.id} className="border-t border-slate-800 align-top">
                    <td className="py-1 pr-3 text-slate-400 text-xs">{fmtTime(s.ts)}</td>
                    <td className="px-2 font-medium">{s.symbol}</td>
                    <td className="px-2">{SETUP_LABEL[s.setup] ?? s.setup}</td>
                    <td className={'px-2 ' + (s.direction === 'long' ? 'text-emerald-400' : 'text-rose-400')}>
                      {s.direction}
                    </td>
                    <td className="text-right px-2 tabular-nums">
                      {s.ml_probability != null ? `${(s.ml_probability * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td className="pl-2 text-slate-400 text-xs">{s.notes ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
