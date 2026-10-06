"use client";
import { use, useEffect, useState } from "react";
import { getRecipe, type Recipe } from "@/lib/api";
import { StepTimer } from "@/components/StepTimer";

export default function CookMode({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    getRecipe(id).then(setRecipe);
  }, [id]);

  // Keep the screen on while cooking.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    return () => void lock?.release();
  }, []);

  if (!recipe) return <p>Loading…</p>;
  const step = recipe.steps[index];

  return (
    <div className="cook">
      <h2>
        Step {index + 1} of {recipe.steps.length}
      </h2>
      <p className="big">{step.body}</p>
      {step.timerSeconds && <StepTimer key={step.id} seconds={step.timerSeconds} />}
      <button disabled={index === 0} onClick={() => setIndex(index - 1)}>Back</button>
      <button disabled={index === recipe.steps.length - 1} onClick={() => setIndex(index + 1)}>Next</button>
    </div>
  );
}
