export function ema(values: number[], span: number): number[] {
  const alpha = 2 / (span + 1);
  const out: number[] = new Array(values.length);
  if (values.length === 0) return out;
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = (1 - alpha) * out[i - 1] + alpha * values[i];
  }
  return out;
}

export function pctChange(values: number[], n: number): number[] {
  const out: number[] = new Array(values.length).fill(0);
  for (let i = n; i < values.length; i++) {
    const prev = values[i - n];
    if (prev !== 0 && !Number.isNaN(values[i])) out[i] = (values[i] - prev) / prev;
  }
  return out;
}