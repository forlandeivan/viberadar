import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { ProbeNotifyConfig, ProbeRunReport, ProbeResult } from './types';

interface Notifier {
  sendReport(report: ProbeRunReport): Promise<void>;
}

class TelegramNotifier implements Notifier {
  private botToken: string;
  private chatId: string;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  async sendReport(report: ProbeRunReport): Promise<void> {
    const failed = report.results.filter(r => r.status === 'failed');
    if (failed.length === 0) return;

    const text = this.formatMessage(report, failed);
    await this.sendMessage(text);

    for (const result of failed) {
      if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
        await this.sendPhoto(result.screenshotPath, `❌ ${result.check}`);
      }
    }
  }

  private formatMessage(report: ProbeRunReport, failed: ProbeResult[]): string {
    const lines: string[] = [
      `🔴 *Probe Alert*`,
      `Target: \`${report.target}\``,
      `Time: ${report.timestamp}`,
      `Result: ${report.passed}/${report.results.length} passed, ${report.failed} failed`,
      '',
    ];

    for (const r of failed) {
      lines.push(`❌ *${escapeMarkdown(r.check)}* (${r.durationMs}ms)`);
      if (r.error) {
        lines.push(`   → ${escapeMarkdown(r.error)}`);
      }
    }

    return lines.join('\n');
  }

  private sendMessage(text: string): Promise<void> {
    const body = JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: 'Markdown',
    });

    return this.apiCall('sendMessage', body, 'application/json');
  }

  private sendPhoto(filePath: string, caption: string): Promise<void> {
    return new Promise((resolve) => {
      const boundary = '----ViberadarBoundary' + Date.now();
      const filename = path.basename(filePath);
      const fileData = fs.readFileSync(filePath);

      const parts: Buffer[] = [];

      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
        `${this.chatId}\r\n`
      ));

      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n` +
        `${caption}\r\n`
      ));

      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
        `Content-Type: image/png\r\n\r\n`
      ));
      parts.push(fileData);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const options: https.RequestOptions = {
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/sendPhoto`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      };

      const req = https.request(options, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          console.warn(`   ⚠️  Telegram sendPhoto failed: HTTP ${res.statusCode}`);
        }
        resolve();
      });

      req.on('error', (err) => {
        console.warn(`   ⚠️  Telegram sendPhoto error: ${err.message}`);
        resolve();
      });

      req.write(body);
      req.end();
    });
  }

  private apiCall(method: string, body: string, contentType: string): Promise<void> {
    return new Promise((resolve) => {
      const options: https.RequestOptions = {
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          console.warn(`   ⚠️  Telegram ${method} failed: HTTP ${res.statusCode}`);
        }
        resolve();
      });

      req.on('error', (err) => {
        console.warn(`   ⚠️  Telegram ${method} error: ${err.message}`);
        resolve();
      });

      req.write(body);
      req.end();
    });
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

export function createNotifiers(config?: ProbeNotifyConfig): Notifier[] {
  const notifiers: Notifier[] = [];
  if (config?.telegram) {
    notifiers.push(new TelegramNotifier(config.telegram.botToken, config.telegram.chatId));
  }
  return notifiers;
}

export async function notifyAll(notifiers: Notifier[], report: ProbeRunReport): Promise<void> {
  for (const n of notifiers) {
    try {
      await n.sendReport(report);
    } catch (err: any) {
      console.warn(`   ⚠️  Notification error: ${err.message}`);
    }
  }
}
