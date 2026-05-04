import { useEffect, useState } from 'react';
import { api, type ModelRow, type SignalRow } from '../api';

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

export function MlPanel() {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [signals, setSignals] = useState<SignalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retraining, setRetraining] = useState(false);
  const [retrainStatus, setRetrainStatus] = useState<string | null>(null);

  const reload = () => {
    setError(null);
    Promise.all([api.models(), api.signals(50)])
      .then(([m, s]) => {
        setModels(m);
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

  return (
    <div className="p-4 space-y-6">
      <section>
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-sm uppercase tracking-wider text-slate-400">Trained models</h2>
          <button
            type="button"
            onClick={retrain}
            disabled={retraining}
            className="px-2 py-1 text-xs rounded bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50"
          >
            {retraining ? 'Retraining…' : 'Retrain now'}
          </button>
          {retrainStatus && <span className="text-xs text-slate-400">{retrainStatus}</span>}
        </div>
        {error && <div className="text-rose-400 text-xs">{error}</div>}
        {models && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="text-left py-1 pr-3">Setup</th>
                  <th className="text-right py-1 px-2">Samples</th>
                  <th className="text-right py-1 px-2">Train acc</th>
                  <th className="text-right py-1 px-2">Val acc</th>
                  <th className="text-right py-1 px-2">Baseline</th>
                  <th className="text-right py-1 px-2">Edge</th>
                  <th className="text-right py-1 pl-2">Trained</th>
                </tr>
              </thead>
              <tbody>
                {models.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-3 text-slate-500 italic">
                      No trained models yet. Click Retrain.
                    </td>
                  </tr>
                )}
                {models.map((m) => {
                  const edge = m.val_accuracy - m.train_baseline;
                  return (
                    <tr key={m.setup} className="border-t border-slate-800">
                      <td className="py-1 pr-3">{SETUP_LABEL[m.setup] ?? m.setup}</td>
                      <td className="text-right px-2 tabular-nums">{m.sample_count}</td>
                      <td className="text-right px-2 tabular-nums">{(m.train_accuracy * 100).toFixed(1)}%</td>
                      <td className="text-right px-2 tabular-nums">{(m.val_accuracy * 100).toFixed(1)}%</td>
                      <td className="text-right px-2 tabular-nums text-slate-500">
                        {(m.train_baseline * 100).toFixed(1)}%
                      </td>
                      <td
                        className={
                          'text-right px-2 tabular-nums ' +
                          (edge > 0 ? 'text-emerald-400' : 'text-rose-400')
                        }
                      >
                        {(edge * 100 >= 0 ? '+' : '') + (edge * 100).toFixed(1)}%
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
                      No signals stored yet. They'll show up here as the ingest worker fires them.
                    </td>
                  </tr>
                )}
                {signals.map((s) => (
                  <tr key={s.id} className="border-t border-slate-800 align-top">
                    <td className="py-1 pr-3 text-slate-400 text-xs">{fmtTime(s.ts)}</td>
                    <td className="px-2 font-medium">{s.symbol}</td>
                    <td className="px-2">{SETUP_LABEL[s.setup] ?? s.setup}</td>
                    <td
                      className={
                        'px-2 ' + (s.direction === 'long' ? 'text-emerald-400' : 'text-rose-400')
                      }
                    >
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
