const modelContextWindows: Readonly<Record<string, number>> = {
  'deepseek/deepseek-v4-flash': 1_048_576,
  'deepseek/deepseek-v4-pro': 1_048_576,
};

export function modelContextWindow(model: string): number | undefined {
  return modelContextWindows[model];
}
