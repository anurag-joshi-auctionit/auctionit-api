/**
 * Failed-password throttle for POST /auth/login.
 *
 * Counts *failed* attempts in a sliding window per login name and per client
 * IP. Once either crosses its limit, further attempts are refused (429) until
 * the oldest failure in the window ages out. A successful login clears the
 * login-name counter. State is per process: with several API instances the
 * effective limit is multiplied by the instance count, which still bounds
 * online guessing.
 */
export const LOGIN_THROTTLE_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILURES_PER_USER = 10;
export const LOGIN_MAX_FAILURES_PER_IP = 50;
const MAX_TRACKED_KEYS = 50_000;

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly windowMs = LOGIN_THROTTLE_WINDOW_MS,
    private readonly maxPerUser = LOGIN_MAX_FAILURES_PER_USER,
    private readonly maxPerIp = LOGIN_MAX_FAILURES_PER_IP,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  /** Milliseconds until another attempt is allowed, or 0 when allowed now. */
  retryAfterMs(loginName: string, ip: string | undefined): number {
    let wait = 0;
    const checks: [string, number][] = [[userKey(loginName), this.maxPerUser]];
    if (ip) checks.push([ipKey(ip), this.maxPerIp]);
    for (const [key, max] of checks) {
      const list = this.recent(key);
      if (list.length >= max) {
        wait = Math.max(wait, list[list.length - max]! + this.windowMs - this.now());
      }
    }
    return Math.max(wait, 0);
  }

  recordFailure(loginName: string, ip: string | undefined): void {
    if (this.failures.size > MAX_TRACKED_KEYS) this.failures.clear();
    const t = this.now();
    for (const key of ip ? [userKey(loginName), ipKey(ip)] : [userKey(loginName)]) {
      this.failures.set(key, [...this.recent(key), t]);
    }
  }

  recordSuccess(loginName: string): void {
    this.failures.delete(userKey(loginName));
  }
}

const userKey = (loginName: string) => `u:${loginName.trim().toLowerCase()}`;
const ipKey = (ip: string) => `ip:${ip}`;

export const loginThrottle = new LoginThrottle();
