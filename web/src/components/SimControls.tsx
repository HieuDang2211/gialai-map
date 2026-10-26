import type { TripStop } from '../api';
import { formatDuration } from '../format';
import { MODE_ICON, type SimState } from '../simulate';

interface Props {
  state: SimState;
  stops: TripStop[];
  roundtrip: boolean;
  mode: string;
  speed: number;
  follow: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (progress: number) => void;
  onSpeed: (speed: number) => void;
  onFollow: (v: boolean) => void;
  onStop: () => void;
}

/** "1 giây xem = N giây đi đường" */
const SPEEDS = [30, 60, 120, 300];

export function SimControls({ state, stops, roundtrip, mode, speed, follow, onPlay, onPause, onSeek, onSpeed, onFollow, onStop }: Props) {
  const target = roundtrip && state.leg >= stops.length - 1 ? stops[0] : stops[Math.min(state.leg + 1, stops.length - 1)];
  const remaining = Math.max(0, state.totalSeconds - state.simSeconds);

  return (
    <div className="sim" role="group" aria-label="Mô phỏng di chuyển">
      <div className="sim-head">
        <span className="sim-icon" aria-hidden>{MODE_ICON[mode]}</span>
        <span className="sim-status" aria-live="polite">
          {state.finished
            ? `Đã đến ${roundtrip ? stops[0].name : stops[stops.length - 1].name}`
            : `Đang đến điểm ${roundtrip && state.leg >= stops.length - 1 ? 1 : state.leg + 2}: ${target?.name ?? ''}`}
          <span className="muted"> · còn {formatDuration(remaining)}</span>
        </span>
      </div>
      <input
        className="sim-range"
        type="range"
        min={0}
        max={1000}
        value={Math.round(state.progress * 1000)}
        onChange={(e) => onSeek(Number(e.target.value) / 1000)}
        aria-label="Vị trí trên hành trình"
      />
      <div className="sim-tools">
        {state.playing ? (
          <button className="btn btn-primary" onClick={onPause}>⏸ Tạm dừng</button>
        ) : (
          <button className="btn btn-primary" onClick={onPlay}>{state.finished ? '↺ Xem lại' : '▶ Chạy'}</button>
        )}
        <label className="sim-speed">
          Tốc độ
          <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
            {!SPEEDS.includes(speed) && <option value={speed}>×{Math.round(speed)}</option>}
            {SPEEDS.map((s) => (
              <option key={s} value={s}>×{s}</option>
            ))}
          </select>
        </label>
        <label className="sim-follow">
          <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} /> Bám theo
        </label>
        <button className="icon-btn sm" onClick={onStop} aria-label="Tắt mô phỏng" title="Tắt mô phỏng">×</button>
      </div>
    </div>
  );
}
