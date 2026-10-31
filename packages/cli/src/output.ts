/** Text that came from another device is untrusted: keep it from driving the terminal. */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString()
}
