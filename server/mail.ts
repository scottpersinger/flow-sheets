// Outgoing email. With RESEND_API_KEY set, mail goes through Resend; otherwise the message is written to the
// server log, which is enough for a single-operator deployment: the password reset link can be copied from
// the Railway logs.
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export type Mailer = (mail: Mail) => Promise<void>;

export function mailerFromEnv(log: (msg: string) => void, env: NodeJS.ProcessEnv = process.env): Mailer {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM ?? 'Sheets <onboarding@resend.dev>';
  if (!key) {
    return async (mail) => {
      log(`[mail] RESEND_API_KEY is not set; not sent. To: ${mail.to} | Subject: ${mail.subject}\n${mail.text}`);
    };
  }
  return async (mail) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}
