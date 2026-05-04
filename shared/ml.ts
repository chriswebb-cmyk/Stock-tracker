import type { SetupName } from './setups';
import { FEATURE_NAMES, type FeatureName } from './features';

export interface ModelStats {
  trainAccuracy: number;
  valAccuracy: number;
  trainBaseline: number; // accuracy of predicting the majority class
  sampleCount: number;
}

export interface Model {
  setup: SetupName;
  featureNames: readonly FeatureName[];
  means: number[];
  stds: number[];
  weights: number[];
  bias: number;
  trainedAt: number;
  stats: ModelStats;
}

export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export function predict(model: Model, rawFeatures: number[]): number {
  let z = model.bias;
  for (let i = 0; i < model.weights.length; i++) {
    const v = rawFeatures[i] ?? 0;
    const std = model.stds[i] || 1;
    const norm = (v - (model.means[i] ?? 0)) / std;
    z += (model.weights[i] ?? 0) * norm;
  }
  return sigmoid(z);
}

interface TrainOptions {
  iterations?: number;
  learningRate?: number;
  l2?: number;
  valFraction?: number;
  seed?: number;
}

// Trains binary logistic regression with z-score normalization. Returns
// trained parameters plus accuracy on a held-out validation split.
export function trainLogReg(
  X: number[][],
  y: number[],
  opts: TrainOptions = {},
): {
  weights: number[];
  bias: number;
  means: number[];
  stds: number[];
  stats: ModelStats;
} {
  const iterations = opts.iterations ?? 400;
  const lr = opts.learningRate ?? 0.1;
  const l2 = opts.l2 ?? 0.001;
  const valFrac = opts.valFraction ?? 0.2;

  const m = X.length;
  if (m === 0 || (X[0]?.length ?? 0) === 0) {
    return {
      weights: [],
      bias: 0,
      means: [],
      stds: [],
      stats: { trainAccuracy: 0, valAccuracy: 0, trainBaseline: 0, sampleCount: 0 },
    };
  }
  const n = X[0]!.length;

  // Deterministic shuffle so retraining on the same data yields the same model.
  const order = shuffleIndices(m, opts.seed ?? 42);
  const X_ = order.map((i) => X[i]!);
  const y_ = order.map((i) => y[i]!);

  const valSize = Math.max(1, Math.floor(m * valFrac));
  const trainSize = m - valSize;
  const X_train = X_.slice(0, trainSize);
  const y_train = y_.slice(0, trainSize);
  const X_val = X_.slice(trainSize);
  const y_val = y_.slice(trainSize);

  const means = new Array<number>(n).fill(0);
  const stds = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < trainSize; i++) s += X_train[i]![j]!;
    means[j] = s / trainSize;
  }
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < trainSize; i++) {
      const d = X_train[i]![j]! - means[j]!;
      s += d * d;
    }
    const variance = s / trainSize;
    stds[j] = Math.sqrt(variance) || 1;
  }

  function normalize(row: number[]): number[] {
    const out = new Array<number>(n);
    for (let j = 0; j < n; j++) out[j] = (row[j]! - means[j]!) / stds[j]!;
    return out;
  }

  const X_train_n = X_train.map(normalize);
  const X_val_n = X_val.map(normalize);

  const weights = new Array<number>(n).fill(0);
  let bias = 0;

  for (let it = 0; it < iterations; it++) {
    const wGrad = new Array<number>(n).fill(0);
    let bGrad = 0;
    for (let i = 0; i < trainSize; i++) {
      const row = X_train_n[i]!;
      let z = bias;
      for (let j = 0; j < n; j++) z += (weights[j] ?? 0) * row[j]!;
      const p = sigmoid(z);
      const err = p - y_train[i]!;
      for (let j = 0; j < n; j++) wGrad[j]! += err * row[j]!;
      bGrad += err;
    }
    for (let j = 0; j < n; j++) {
      const grad = wGrad[j]! / trainSize + l2 * (weights[j] ?? 0);
      weights[j] = (weights[j] ?? 0) - lr * grad;
    }
    bias -= lr * (bGrad / trainSize);
  }

  function classify(row: number[]): number {
    let z = bias;
    for (let j = 0; j < n; j++) z += (weights[j] ?? 0) * row[j]!;
    return sigmoid(z) >= 0.5 ? 1 : 0;
  }
  let trainCorrect = 0;
  for (let i = 0; i < trainSize; i++) {
    if (classify(X_train_n[i]!) === y_train[i]) trainCorrect += 1;
  }
  let valCorrect = 0;
  for (let i = 0; i < valSize; i++) {
    if (classify(X_val_n[i]!) === y_val[i]) valCorrect += 1;
  }
  const trainPositives = y_train.filter((v) => v === 1).length;
  const baseline = Math.max(trainPositives, trainSize - trainPositives) / trainSize;

  return {
    weights,
    bias,
    means,
    stds,
    stats: {
      trainAccuracy: trainSize > 0 ? trainCorrect / trainSize : 0,
      valAccuracy: valSize > 0 ? valCorrect / valSize : 0,
      trainBaseline: baseline,
      sampleCount: m,
    },
  };
}

// Mulberry32 PRNG via seed for reproducible shuffles.
function shuffleIndices(n: number, seed: number): number[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

export function modelToJson(m: Model): string {
  return JSON.stringify({
    featureNames: m.featureNames,
    means: m.means,
    stds: m.stds,
    weights: m.weights,
    bias: m.bias,
  });
}

export function modelFromJson(setup: SetupName, json: string, trainedAt: number, stats: ModelStats): Model | null {
  try {
    const obj = JSON.parse(json) as {
      featureNames?: FeatureName[];
      means?: number[];
      stds?: number[];
      weights?: number[];
      bias?: number;
    };
    if (!obj.weights || !obj.means || !obj.stds || obj.bias === undefined) return null;
    return {
      setup,
      featureNames: obj.featureNames ?? FEATURE_NAMES,
      means: obj.means,
      stds: obj.stds,
      weights: obj.weights,
      bias: obj.bias,
      trainedAt,
      stats,
    };
  } catch {
    return null;
  }
}
