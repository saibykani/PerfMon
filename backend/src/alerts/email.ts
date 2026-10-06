import { config } from '../config.js';

let transporter: any = null;

/** Sends an email when SMTP is configured. Returns false when email is not configured. */
export async function sendEmail(to: string | string[], subject: string, text: string, html?: string): Promise<boolean> {
  if (!config.smtp.host) return false;
  if (!transporter) {
    const nodemailer = await import('nodemailer');
    transporter = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    });
  }
  await transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
  return true;
}
