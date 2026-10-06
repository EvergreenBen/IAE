"use client";
import { useEffect, useState } from "react";

export function StepTimer({ seconds }: { seconds: number }) {
  const [left, setLeft] = useState(seconds);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!running || left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [running, left]);

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");

  return (
    <button onClick={() => setRunning((r) => !r)} aria-pressed={running}>
      {left === 0 ? "Done!" : `${mm}:${ss}`} {running ? "Pause" : "Start"}
    </button>
  );
}
