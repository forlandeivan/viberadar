export interface ProbeConfig {
  target: string;
  interval: number;      // seconds
  timeout: number;       // ms per step
  notify?: ProbeNotifyConfig;
  checks: ProbeCheck[];
  e2eEmail?: string;     // credentials injected into file-based checks
  e2ePassword?: string;
}

export interface ProbeNotifyConfig {
  telegram?: {
    botToken: string;
    chatId: string;
  };
}

export interface ProbeCheck {
  name: string;
  steps?: ProbeStep[];   // DSL-шаги (inline)
  file?: string;         // путь к Playwright spec файлу (относительно cwd)
}

export type ProbeStep =
  | { goto: string }
  | { fill: { selector: string; value: string } }
  | { click: string }
  | { wait: number }
  | { 'expect.visible': string }
  | { 'expect.text': { selector: string; contains: string } };

export interface ProbeResult {
  check: string;
  status: 'passed' | 'failed';
  durationMs: number;
  error?: string;
  screenshotPath?: string;
}

export interface ProbeRunReport {
  target: string;
  timestamp: string;
  results: ProbeResult[];
  passed: number;
  failed: number;
}
