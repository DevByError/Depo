import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { advance, type ReplayIndex } from "./team-replay";

export const SPEEDS = [1, 4, 16] as const;
export type ReplaySpeed = (typeof SPEEDS)[number];

/** Playback ticks this often (wall time); each tick moves `TICK_MS * speed` of run time. */
export const TICK_MS = 100;

export interface ReplayPlayer {
  /** The moment picked, or null for the live edge (a running task) or the end (a finished one). */
  cursor: number | null;
  playing: boolean;
  speed: ReplaySpeed;
  seek(t: number): void;
  goLive(): void;
  play(): void;
  pause(): void;
  toggle(): void;
  setSpeed(s: ReplaySpeed): void;
  /** Tell the player the run it moves through and where its live edge is (every render). */
  sync(index: ReplayIndex | null, edge: number): void;
}

/**
 * The replay's transport: where it is, whether it plays, and how fast. Playing moves through run
 * time at 1x, 4x or 16x, with long quiet stretches cut short; reaching the edge goes back to live.
 * The cursor is the input of `useTeamView`, whose index and edge come back through `sync`.
 */
export function useReplayPlayer(taskId: string | null): ReplayPlayer {
  const [cursor, setCursorState] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(4);
  const cursorRef = useRef<number | null>(null);
  const indexRef = useRef<ReplayIndex | null>(null);
  const edgeRef = useRef(0);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  // Read by the timer, so a tick that fires between Pause and the timer's cleanup does nothing.
  const playingRef = useRef(false);
  const sync = useCallback((index: ReplayIndex | null, edge: number) => {
    indexRef.current = index;
    edgeRef.current = edge;
  }, []);

  const setCursor = useCallback((c: number | null) => {
    cursorRef.current = c;
    setCursorState(c);
  }, []);

  // Another task starts at its live edge (or its end), paused.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets only when the task changes.
  useEffect(() => {
    setCursor(null);
    playingRef.current = false;
    setPlaying(false);
  }, [taskId]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const idx = indexRef.current;
      if (!idx || !playingRef.current) return;
      const end = edgeRef.current;
      const next = advance(idx, cursorRef.current ?? idx.start, TICK_MS * speedRef.current, end);
      if (next >= end) {
        setCursor(null);
        playingRef.current = false;
        setPlaying(false);
      } else setCursor(next);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, setCursor]);

  const seek = useCallback(
    (t: number) => {
      const idx = indexRef.current;
      if (!idx) return;
      const end = edgeRef.current;
      setCursor(t >= end ? null : Math.max(idx.start, t));
    },
    [setCursor],
  );
  const play = useCallback(() => {
    const idx = indexRef.current;
    if (!idx) return;
    // From the edge, the film starts at the beginning.
    if (cursorRef.current === null) setCursor(idx.start);
    playingRef.current = true;
    setPlaying(true);
  }, [setCursor]);
  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
  }, []);
  const goLive = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    setCursor(null);
  }, [setCursor]);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  return useMemo(
    () => ({ cursor, playing, speed, seek, goLive, play, pause, toggle, setSpeed, sync }),
    [cursor, playing, speed, seek, goLive, play, pause, toggle, sync],
  );
}
