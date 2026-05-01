import type { IngestRun } from '../../../shared/types';

interface Props {
  latest: IngestRun | null;
}

function ago(ts: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function StatusBar({ latest }: Props) {
  if (!latest) {
    return (
      <div className="text-xs text-slate-500 px-3 py-2">
        No ingest runs yet — make sure the worker cron is firing.
      </div>
    );
  }
  const ts = latest.finishedAt ?? latest.startedAt;
  const isHealthy = latest.errors === 0 && latest.finishedAt !== null;
  return (
    <div className="text-xs px-3 py-2 flex items-center gap-3">
      <span
        className={
          'inline-block w-2 h-2 rounded-full ' +
          (isHealthy ? 'bg-emerald-400' : 'bg-amber-400')
        }
        aria-hidden
      />
      <span className="text-slate-400">
        Last poll {ago(ts)} · {latest.symbols} symbols · {latest.apiCalls} API calls
        {latest.errors > 0 && (
          <span
            className="text-amber-300"
            title={latest.errorText ?? undefined}
          >
            {' · '}{latest.errors} errors
          </span>
        )}
      </span>
    </div>
  );
}
